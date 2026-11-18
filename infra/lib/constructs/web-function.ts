/**
 * KUKAN Web Function Construct (ADR-068)
 * The Next.js web on Lambda Web Functions: the same server as the image, from
 * a zip, behind CloudFront with OAC and reaching the VPC through a network
 * connector of its own.
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

export class WebFunctionConstruct extends Construct {
  readonly webFunction: lambda.WebFunction

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

    this.webFunction = new lambda.WebFunction(this, 'Function', {
      code: lambda.WebFunctionCode.fromAssetToManagedBucket(REPO_ROOT, webFunctionAsset(props)),
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
 * The zip, built by the Dockerfile's `web-function` target with the site's
 * brand. Hashed on the same sources as the images (.dockerignore), so an
 * unchanged tree reuses the staged zip instead of building again.
 */
function webFunctionAsset(props: WebFunctionProps): lambda.WebFunctionManagedBucketAssetOptions {
  const buildArgs = props.imageBuildArgs ?? {}
  return {
    exclude: dockerignore(),
    ignoreMode: cdk.IgnoreMode.DOCKER,
    bundling: {
      // Never pulled: the local build below always takes it
      image: cdk.DockerImage.fromRegistry('kukan-web-function-build'),
      // In the bundling options so each set of build args (a brand) gets an
      // asset of its own; the same args as the site's image
      environment: buildArgs,
      local: {
        tryBundle(outputDir) {
          execFileSync(
            'docker',
            [
              'build',
              '--target',
              'web-function',
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
