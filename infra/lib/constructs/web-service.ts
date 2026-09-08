/**
 * KUKAN Web Service Construct
 * ECS Fargate service for the Next.js web application, fronted either by its
 * own internal ALB (single-site) or by a target group + listener rule on the
 * environment's shared ALB (multi-site, ADR-049).
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as assets from 'aws-cdk-lib/aws-ecr-assets'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'
import { configureBedrockEmbedding, configureBedrockCompletion } from './ai.js'
import type { DbAccess } from './database.js'
import { createInternalAlb, SITE_ROUTING_HEADER } from './shared-alb.js'

/** Attachment to the environment's shared ALB listener (ADR-049). */
export interface SharedListenerAttachment {
  listener: elbv2.IApplicationListener
  /** Listener rule priority — unique per environment (config resolveAlbPriority). */
  priority: number
  /** Value of the X-Kukan-Site origin header the rule matches (kukan-<env>-<site>). */
  siteKey: string
}

export interface WebServiceProps {
  config: KukanConfig
  cluster: ecs.ICluster
  /** SG of the site's own ALB. Required unless `sharedListener` is set. */
  albSecurityGroup?: ec2.ISecurityGroup
  webSecurityGroup: ec2.ISecurityGroup
  database: DbAccess
  authSecret: secretsmanager.ISecret
  bucket: s3.IBucket
  queue: sqs.IQueue
  searchDomainEndpoint?: string
  /** Per-site OPENSEARCH_INDEX_PREFIX (ADR-041). Unset → app default (`kukan`). */
  searchIndexPrefix?: string
  /** Docker build args for the web image (KUKAN_BRAND, ADR-042). */
  imageBuildArgs?: Record<string, string>
  /** Attach to the shared ALB instead of creating one (ADR-049). */
  sharedListener?: SharedListenerAttachment
  /** Secrets Manager secret containing GA4 property ID (numeric) */
  ga4PropertyIdSecret?: secretsmanager.ISecret
  /** Secrets Manager secret containing GA4 service account email */
  ga4ClientEmailSecret?: secretsmanager.ISecret
  /** Secrets Manager secret containing GA4 service account private key */
  ga4PrivateKeySecret?: secretsmanager.ISecret
}

export class WebServiceConstruct extends Construct {
  /** Own internal ALB (CloudFront VPC origin). Undefined on the shared ALB. */
  readonly loadBalancer?: elbv2.IApplicationLoadBalancer
  private readonly webContainer: ecs.ContainerDefinition

  /** Add an environment variable to the web container after construction. */
  addEnvironment(key: string, value: string) {
    this.webContainer.addEnvironment(key, value)
  }

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id)

    const {
      config,
      cluster,
      albSecurityGroup,
      webSecurityGroup,
      database,
      authSecret,
      bucket,
      queue,
      searchDomainEndpoint,
      ga4PropertyIdSecret,
      ga4ClientEmailSecret,
      ga4PrivateKeySecret,
    } = props

    // Docker image (built and pushed automatically by CDK).
    // CDK auto-loads the build context's .dockerignore into the asset-hash
    // exclude list, so it is the single source of truth. IgnoreMode.DOCKER makes
    // those patterns match like Docker (incl. nested node_modules); without it
    // the default GLOB mode misses nested node_modules and the hash churns on
    // every install, producing spurious image diffs.
    const imageAsset = new assets.DockerImageAsset(this, 'WebImage', {
      directory: '../',
      file: 'Dockerfile',
      target: 'web',
      platform: assets.Platform.LINUX_AMD64,
      ignoreMode: cdk.IgnoreMode.DOCKER,
      buildArgs: props.imageBuildArgs,
    })

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.web.cpu,
      memoryLimitMiB: config.web.memory,
    })

    // Grant permissions to task role
    bucket.grantReadWrite(taskDef.taskRole)
    queue.grantSendMessages(taskDef.taskRole)
    queue.grant(taskDef.taskRole, 'sqs:GetQueueAttributes')

    // Environment variables
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      ...database.buildPostgresEnvironment(),
      S3_BUCKET: bucket.bucketName,
      S3_REGION: cdk.Aws.REGION,
      SQS_REGION: cdk.Aws.REGION,
      SQS_QUEUE_URL: queue.queueUrl,
      SEARCH_TYPE: searchDomainEndpoint ? 'opensearch' : 'postgres',
      WEB_DB_POOL_MAX: String(config.dbPool.webMax),
    }
    configureBedrockEmbedding(config, taskDef, environment)
    configureBedrockCompletion(config, taskDef, environment)
    if (searchDomainEndpoint) {
      environment.OPENSEARCH_URL = `https://${searchDomainEndpoint}`
      environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
      if (props.searchIndexPrefix) {
        environment.OPENSEARCH_INDEX_PREFIX = props.searchIndexPrefix
      }
    }
    if (config.domainName) {
      environment.BETTER_AUTH_URL = `https://${config.domainName}`
    }
    // Secrets injected into the container
    const containerSecrets: Record<string, ecs.Secret> = {
      ...database.buildPostgresSecrets(),
      BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
    }
    if (ga4PropertyIdSecret) {
      containerSecrets.GA4_PROPERTY_ID = ecs.Secret.fromSecretsManager(ga4PropertyIdSecret)
    }
    if (ga4ClientEmailSecret) {
      containerSecrets.GA4_CLIENT_EMAIL = ecs.Secret.fromSecretsManager(ga4ClientEmailSecret)
    }
    if (ga4PrivateKeySecret) {
      containerSecrets.GA4_PRIVATE_KEY = ecs.Secret.fromSecretsManager(ga4PrivateKeySecret)
    }

    // Container
    this.webContainer = taskDef.addContainer('Web', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      environment,
      secrets: containerSecrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: new logs.LogGroup(this, 'WebLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        streamPrefix: 'web',
      }),
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          'CMD-SHELL',
          'wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    })

    // Fargate Service
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: resourceName(this, 'web'),
      taskDefinition: taskDef,
      desiredCount: config.web.minSize,
      securityGroups: [webSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
    })

    const healthCheck: elbv2.HealthCheck = {
      path: '/api/health',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    }

    let targetGroup: elbv2.ApplicationTargetGroup
    if (props.sharedListener) {
      // Shared ALB (ADR-049): own target group, routed by the site header. The
      // rule lives under this construct (not the imported listener) so its
      // logical id is owned here and it inherits this construct's dependencies.
      const { listener, priority, siteKey } = props.sharedListener
      targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
        vpc: cluster.vpc,
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      })
      new elbv2.ApplicationListenerRule(this, 'SiteRule', {
        listener,
        priority,
        conditions: [elbv2.ListenerCondition.httpHeader(SITE_ROUTING_HEADER, [siteKey])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      })
    } else {
      if (!albSecurityGroup) {
        throw new Error('WebServiceConstruct needs albSecurityGroup unless sharedListener is set')
      }
      const alb = createInternalAlb(this, { vpc: cluster.vpc, securityGroup: albSecurityGroup })
      targetGroup = alb.listener.addTargets('WebTarget', {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      })
      this.loadBalancer = alb.loadBalancer
    }

    // Auto Scaling
    if (config.web.maxSize > config.web.minSize) {
      const scaling = service.autoScaleTaskCount({
        minCapacity: config.web.minSize,
        maxCapacity: config.web.maxSize,
      })
      scaling.scaleOnRequestCount('RequestCount', {
        requestsPerTarget: 1000,
        targetGroup,
      })
    }

    cdk.Tags.of(this).add('kukan:component', 'web-service')
  }
}
