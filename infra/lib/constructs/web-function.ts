/**
 * KUKAN Web Function Construct (ADR-068)
 * The Next.js web on Lambda Web Functions: the same server as the image, from
 * a zip, behind CloudFront with OAC and reaching the VPC through a network
 * connector of its own. Its static files are not in the zip: they go to a
 * bucket of their own, which CloudFront serves them from.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import { Construct } from 'constructs'
import { envPrefix, webFunctionRoleName } from '../naming.js'
import { configureWebApp, type WebAppProps } from './web-service.js'

/** Where Web Functions unpack the zip. */
const CODE_ROOT = '/var/task'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface WebFunctionProps extends WebAppProps {
  vpc: ec2.IVpc
  /** The environment's shared connector SG, which the DB, OpenSearch and worker admit. */
  connectorSecurityGroup: ec2.ISecurityGroup
}

/** Cache-Control of the files whose names change with their content. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Of the static files, those named by their content or by a versioned
 * directory: Next's hashed files, and the ibisOffice app's own (`pkg`,
 * `assets`). Its boot page and SOURCE beside them may change under the same
 * version. The same split as next.config.ts makes for the image.
 */
const IMMUTABLE_FILES = [
  '_next/static/*',
  'vendor/ibis-office/*/pkg/*',
  'vendor/ibis-office/*/assets/*',
]

export class WebFunctionConstruct extends Construct {
  readonly webFunction: lambda.WebFunction
  /** Where CloudFront serves `/_next/static/*` and `/vendor/ibis-office/*` from. */
  readonly staticBucket: s3.Bucket

  /**
   * Add an environment variable after construction. Onto the revision: the
   * WebFunction copies its `environment` when it is built.
   */
  addEnvironment(key: string, value: string) {
    this.webFunction.resourceRevision.addPropertyOverride(
      `ServiceConfig.EnvironmentVariables.${key}`,
      value
    )
  }

  constructor(scope: Construct, id: string, props: WebFunctionProps) {
    super(scope, id)

    const { config } = props

    // Named so the search domain's role mapping can name it before it exists
    // (ADR-069), and named apart from the task role (naming.ts)
    const role = new iam.Role(this, 'ExecutionRole', {
      roleName: webFunctionRoleName(envPrefix(this)),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    const { environment, secrets } = configureWebApp(props, role)
    // Read at startup (packages/api/src/secrets.ts): a revision takes plain
    // variables only, and a secret baked in would need a new one per change
    const secretArns: Record<string, string> = {}
    for (const [name, secret] of Object.entries(secrets)) {
      secretArns[name] = secret.arn
      secret.grantRead(role)
    }
    const functionEnvironment = {
      ...environment,
      SECRET_ARNS: cdk.Stack.of(this).toJsonString(secretArns),
      // What the image sets in its Dockerfile, at the zip's paths
      POSTGRES_SSLROOTCERT: `${CODE_ROOT}/rds-ca.crt`,
      QUERY_CHILD_ENTRY: `${CODE_ROOT}/node_modules/.pnpm/kukan-query-child.mjs`,
      DUCKDB_EXTENSION_DIRECTORY: `${CODE_ROOT}/duckdb-extensions`,
    }

    // Its own connector, so a connector update replaces the revision in the
    // same deployment (ADR-068 §決定 2). Its operator role is the L2's own:
    // the execution role must not manage network interfaces.
    const connector = new lambda.NetworkConnector(this, 'Connector', {
      configuration: lambda.NetworkConnectorConfiguration.vpcEgress({
        computeType: lambda.NetworkConnectorComputeType.WEB_FUNCTION,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [props.connectorSecurityGroup],
        networkProtocol: lambda.NetworkConnectorProtocol.DUAL_STACK,
      }),
    })

    // The static files, uploaded before the function takes the pages that name
    // them. Never pruned: a page cached at the edge or open in a browser still
    // names the last deploy's hashes, and those files cost next to nothing.
    this.staticBucket = new s3.Bucket(this, 'StaticBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const staticFiles = s3deploy.Source.asset(
      REPO_ROOT,
      dockerTargetAsset('web-function-static', props.imageBuildArgs ?? {})
    )
    const deployments = [
      new s3deploy.BucketDeployment(this, 'StaticImmutable', {
        sources: [staticFiles],
        destinationBucket: this.staticBucket,
        exclude: ['*'],
        include: IMMUTABLE_FILES,
        cacheControl: [s3deploy.CacheControl.fromString(IMMUTABLE)],
        prune: false,
        ...STATIC_DEPLOYMENT_SIZE,
      }),
      new s3deploy.BucketDeployment(this, 'StaticRevalidated', {
        sources: [staticFiles],
        destinationBucket: this.staticBucket,
        exclude: IMMUTABLE_FILES,
        cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0')],
        prune: false,
        ...STATIC_DEPLOYMENT_SIZE,
      }),
    ]

    this.webFunction = new lambda.WebFunction(this, 'Function', {
      code: lambda.WebFunctionCode.fromAssetToManagedBucket(
        REPO_ROOT,
        dockerTargetAsset('web-function', props.imageBuildArgs ?? {})
      ),
      runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
      entryPoint: 'apps/web/start.mjs',
      role,
      egressNetworkConnector: connector,
      environment: functionEnvironment,
      logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH }),
      // The whole response, streaming included: a large download or a slow
      // query must not be cut where the ALB would have let it run. The most
      // Web Functions allow; idle time costs nothing but memory
      timeout: cdk.Duration.minutes(15),
      defaultEndpointAuth: lambda.WebFunctionAuthType.IAM_AUTH,
      defaultEndpoint: { maxEnvironments: config.webFunction.maxInstances },
    })

    for (const deployment of deployments) this.webFunction.node.addDependency(deployment)

    cdk.Tags.of(this).add('kukan:component', 'web-function')
  }

  /** The endpoint's domain, CloudFront's origin. */
  get domainName(): string {
    return this.webFunction.endpoint.domainName
  }

  /** Let this distribution, and nothing else, invoke the endpoint (OAC). */
  allowDistribution(distribution: cloudfront.IDistribution) {
    this.webFunction.endpoint.grants.invoke(
      new iam.ServicePrincipal('cloudfront.amazonaws.com', {
        conditions: { ArnEquals: { 'aws:SourceArn': distribution.distributionArn } },
      })
    )
  }
}

/**
 * The upload of the static files: about 200 MB unpacked, past what the
 * deployment's default handler (128 MB of memory, 512 MB of disk) holds.
 */
const STATIC_DEPLOYMENT_SIZE = {
  memoryLimit: 1024,
  ephemeralStorageSize: cdk.Size.gibibytes(2),
}

/**
 * The output of one of the Dockerfile's targets — `web-function` (the zip) or
 * `web-function-static` (its static files) — built with the site's brand.
 * Hashed on the same sources as the images (.dockerignore), so an unchanged
 * tree reuses the staged output instead of building again; and the two
 * targets share the build in Docker's cache.
 */
function dockerTargetAsset(
  target: string,
  buildArgs: Record<string, string>
): s3assets.AssetOptions {
  return {
    exclude: dockerignore(),
    ignoreMode: cdk.IgnoreMode.DOCKER,
    bundling: {
      // Never pulled: the local build below always takes it
      image: cdk.DockerImage.fromRegistry('kukan-web-function-build'),
      // In the bundling options so each target and set of build args (a
      // brand) gets an asset of its own; the same args as the site's image
      environment: { ...buildArgs, KUKAN_DOCKER_TARGET: target },
      local: {
        tryBundle(outputDir) {
          execFileSync(
            'docker',
            [
              'build',
              '--target',
              target,
              ...Object.entries(buildArgs).flatMap(([key, value]) => [
                '--build-arg',
                `${key}=${value}`,
              ]),
              '--output',
              `type=local,dest=${outputDir}`,
              '--file',
              path.join(REPO_ROOT, 'Dockerfile'),
              REPO_ROOT,
            ],
            { stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1' } }
          )
          return true
        },
      },
    },
  }
}

/** The repository's .dockerignore patterns, read once for every site. */
let dockerignorePatterns: string[] | undefined
function dockerignore(): string[] {
  dockerignorePatterns ??= readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return dockerignorePatterns
}
