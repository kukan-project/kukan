/**
 * Stack composition functions (ADR-041).
 *
 * The all-in-one KukanStack and the multi-site Shared/Site stacks are built
 * from these two functions. They MUST stay plain functions taking the stack as
 * `scope` — wrapping them in a Construct would insert a node into the construct
 * tree, changing every logical ID and replacing all resources in deployed
 * single-site environments. The synth snapshot tests in `__tests__/` are the
 * guard: a diff there means an existing environment would see a CloudFormation
 * change.
 */

import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import type { KukanConfig } from './config.js'
import { envPrefix } from './naming.js'
import { NetworkConstruct } from './constructs/network.js'
import { EcrAssetRetentionConstruct } from './constructs/ecr-asset-retention.js'
import { DatabaseConstruct, type DbAccess } from './constructs/database.js'
import { StorageConstruct } from './constructs/storage.js'
import { QueueConstruct } from './constructs/queue.js'
import { SearchConstruct } from './constructs/search.js'
import { WebServiceConstruct } from './constructs/web-service.js'
import { WorkerServiceConstruct } from './constructs/worker-service.js'
import { CdnConstruct } from './constructs/cdn.js'
import { SITE_ROUTING_HEADER } from './constructs/shared-alb.js'

/** The hourly-billed "boxes" shared across sites (ADR-041). */
export interface SharedResources {
  network: NetworkConstruct
  database: DatabaseConstruct
  search?: SearchConstruct
  cluster: ecs.Cluster
}

/** The shared ALB as imported by a SiteStack (ADR-049). */
export interface SharedAlbSurface {
  listener: elbv2.IApplicationListener
  dnsName: string
  vpcOrigin: cloudfront.IVpcOrigin
  /** This site's listener rule priority (config resolveAlbPriority). */
  priority: number
}

/**
 * What one site needs from the shared boxes. Single-site passes the constructs
 * directly; multi-site SiteStacks will pass SSM-imported handles (ADR-041).
 */
export interface SiteSurface {
  cluster: ecs.ICluster
  /** SG for the site's own ALB — not needed on the shared ALB. */
  albSecurityGroup?: ec2.ISecurityGroup
  webSecurityGroup: ec2.ISecurityGroup
  workerSecurityGroup: ec2.ISecurityGroup
  db: DbAccess
  searchDomainEndpoint?: string
  /** Per-site OPENSEARCH_INDEX_PREFIX (ADR-041). Unset → containers use the app default. */
  searchIndexPrefix?: string
  /** Per-site web image build args (KUKAN_BRAND, ADR-042). */
  webImageBuildArgs?: Record<string, string>
  /** Shared ALB to attach to; unset → the site gets its own ALB (ADR-049). */
  sharedAlb?: SharedAlbSurface
}

/** Handles the composing stack needs after composition (ordering, backup). */
export interface SiteResources {
  webService: WebServiceConstruct
  workerService: WorkerServiceConstruct
  bucket: s3.IBucket
}

/** Edge resources created in us-east-1 (KukanGlobalStack) or supplied as ARNs. */
export interface EdgeArns {
  certificateArn?: string
  webAclArn?: string
}

/** Create the shared resources on `scope` (ids unchanged from the pre-split stack). */
export function composeShared(scope: Construct, config: KukanConfig): SharedResources {
  const network = new NetworkConstruct(scope, 'Network', { config })

  const database = new DatabaseConstruct(scope, 'Database', {
    config,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
  })

  let search: SearchConstruct | undefined
  if (config.enableOpenSearch) {
    search = new SearchConstruct(scope, 'Search', {
      config,
      vpc: network.vpc,
      searchSecurityGroup: network.searchSecurityGroup,
    })
  }

  // Env-prefixed name for readability + multi-environment uniqueness (ADR-031).
  const cluster = new ecs.Cluster(scope, 'Cluster', {
    vpc: network.vpc,
    clusterName: envPrefix(scope),
  })

  // Not a box: an account/region-wide side effect (lifecycle policy on the
  // bootstrap container-assets repository), applied once per environment.
  new EcrAssetRetentionConstruct(scope, 'EcrAssetRetention', { keep: config.ecrImageRetention })

  return { network, database, search, cluster }
}

/** Create one site's resources on `scope` (ids unchanged from the pre-split stack). */
export function composeSite(
  scope: Construct,
  config: KukanConfig,
  surface: SiteSurface,
  edge: EdgeArns = {}
): SiteResources {
  // --- Auth Secret ---
  const authSecret = new secretsmanager.Secret(scope, 'AuthSecret', {
    generateSecretString: { excludePunctuation: true, passwordLength: 64 },
  })

  // --- Storage (S3) ---
  const storage = new StorageConstruct(scope, 'Storage', { config })

  // --- Queue (SQS) ---
  const queue = new QueueConstruct(scope, 'Queue')

  // --- GA4 Analytics (optional) ---
  // After deploy, find the secret ARNs in the stack outputs or Secrets Manager console,
  // then set the values via:
  //   aws secretsmanager put-secret-value --secret-id <Ga4PropertyIdSecret ARN> --secret-string "123456789"
  //   aws secretsmanager put-secret-value --secret-id <Ga4ClientEmailSecret ARN> --secret-string "sa@project.iam.gserviceaccount.com"
  //   aws secretsmanager put-secret-value --secret-id <Ga4PrivateKeySecret ARN> --secret-string "$(cat key.pem)"
  let ga4PropertyIdSecret: secretsmanager.ISecret | undefined
  let ga4ClientEmailSecret: secretsmanager.ISecret | undefined
  let ga4PrivateKeySecret: secretsmanager.ISecret | undefined
  if (config.enableGa4DataApi) {
    ga4PropertyIdSecret = new secretsmanager.Secret(scope, 'Ga4PropertyIdSecret', {
      description: 'GA4 property ID (numeric)',
    })
    ga4ClientEmailSecret = new secretsmanager.Secret(scope, 'Ga4ClientEmailSecret', {
      description: 'GA4 service account email',
    })
    ga4PrivateKeySecret = new secretsmanager.Secret(scope, 'Ga4PrivateKeySecret', {
      description: 'GA4 service account private key',
    })
  }

  // --- Web Service (ECS Fargate + internal ALB) ---
  // CloudFront connects to ALB via VPC origin — no public IPs on ALB.
  // On the shared ALB (ADR-049) the site is routed by the X-Kukan-Site header:
  // the listener rule below matches the value the CloudFront origin sends —
  // both sides of that contract are wired here.
  const siteKey = envPrefix(scope)
  const { sharedAlb } = surface
  const webService = new WebServiceConstruct(scope, 'WebService', {
    config,
    cluster: surface.cluster,
    albSecurityGroup: surface.albSecurityGroup,
    webSecurityGroup: surface.webSecurityGroup,
    database: surface.db,
    authSecret,
    bucket: storage.bucket,
    queue: queue.queue,
    searchDomainEndpoint: surface.searchDomainEndpoint,
    searchIndexPrefix: surface.searchIndexPrefix,
    imageBuildArgs: surface.webImageBuildArgs,
    sharedListener: sharedAlb && {
      listener: sharedAlb.listener,
      priority: sharedAlb.priority,
      siteKey,
    },
    ga4PropertyIdSecret,
    ga4ClientEmailSecret,
    ga4PrivateKeySecret,
  })

  // --- Worker Service (ECS Fargate) ---
  const workerService = new WorkerServiceConstruct(scope, 'WorkerService', {
    config,
    cluster: surface.cluster,
    workerSecurityGroup: surface.workerSecurityGroup,
    database: surface.db,
    authSecret,
    bucket: storage.bucket,
    queue: queue.queue,
    searchDomainEndpoint: surface.searchDomainEndpoint,
    searchIndexPrefix: surface.searchIndexPrefix,
  })

  // --- CDN (CloudFront with VPC origin) ---
  // Own ALB: the VpcOrigin resource is created at bind time under the
  // distribution, so building the origin here keeps the single-site logical ids.
  // Shared ALB: the imported VPC origin carries no domain name — pass the ALB's.
  const origin = sharedAlb
    ? origins.VpcOrigin.withVpcOrigin(sharedAlb.vpcOrigin, {
        domainName: sharedAlb.dnsName,
        customHeaders: { [SITE_ROUTING_HEADER]: siteKey },
      })
    : origins.VpcOrigin.withApplicationLoadBalancer(webService.loadBalancer!, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 80,
      })
  const cdn = new CdnConstruct(scope, 'CDN', {
    config,
    origin,
    certificateArn: edge.certificateArn,
    webAclArn: edge.webAclArn,
  })

  // Set BETTER_AUTH_URL to CloudFront domain when no custom domain
  if (!config.domainName) {
    webService.addEnvironment('BETTER_AUTH_URL', `https://${cdn.distributionDomainName}`)
  }

  // --- DNS Record (A Alias → CloudFront) ---
  if (config.domainName && config.hostedZoneId && config.hostedZoneName) {
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(scope, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    })

    new route53.ARecord(scope, 'DnsRecord', {
      zone: hostedZone,
      recordName: config.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(cdn.distribution)),
    })
  }

  // --- Outputs ---
  new cdk.CfnOutput(scope, 'CloudFrontDomainName', {
    value: cdn.distributionDomainName,
    description: 'CloudFront Distribution Domain Name',
  })
  // The shared ALB's name is published once, as the SharedStack's SSM parameter
  if (webService.loadBalancer) {
    new cdk.CfnOutput(scope, 'AlbDnsName', {
      value: webService.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS Name (internal, behind CloudFront)',
    })
  }
  new cdk.CfnOutput(scope, 'BucketName', {
    value: storage.bucket.bucketName,
    description: 'S3 Bucket Name',
  })

  return { webService, workerService, bucket: storage.bucket }
}
