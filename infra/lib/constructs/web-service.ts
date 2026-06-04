/**
 * KUKAN Web Service Construct
 * ECS Fargate service with ALB for Next.js web application.
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
import { DOCKER_ASSET_EXCLUDES } from '../docker-excludes.js'
import type { DatabaseConstruct } from './database.js'

export interface WebServiceProps {
  config: KukanConfig
  cluster: ecs.ICluster
  albSecurityGroup: ec2.ISecurityGroup
  webSecurityGroup: ec2.ISecurityGroup
  database: DatabaseConstruct
  authSecret: secretsmanager.ISecret
  bucket: s3.IBucket
  queue: sqs.IQueue
  searchDomainEndpoint?: string
  /**
   * Origin Verify header value for ALB listener rule (ADR-027).
   * When set, ALB rejects requests without a matching X-Origin-Verify header.
   */
  originVerifyHeaderValue?: string
}

export class WebServiceConstruct extends Construct {
  /** ALB DNS name — used for CloudFront origin / Route53. */
  readonly loadBalancerDnsName: string
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
      originVerifyHeaderValue,
    } = props

    // Docker image (built and pushed automatically by CDK)
    // exclude mirrors .dockerignore so CDK asset hash ignores non-app files
    const imageAsset = new assets.DockerImageAsset(this, 'WebImage', {
      directory: '../',
      file: 'Dockerfile',
      target: 'web',
      platform: assets.Platform.LINUX_AMD64,
      exclude: DOCKER_ASSET_EXCLUDES,
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
      AI_TYPE: 'none',
      S3_BUCKET: bucket.bucketName,
      S3_REGION: cdk.Aws.REGION,
      SQS_REGION: cdk.Aws.REGION,
      SQS_QUEUE_URL: queue.queueUrl,
      SEARCH_TYPE: searchDomainEndpoint ? 'opensearch' : 'postgres',
      WEB_DB_POOL_MAX: String(config.dbPool.webMax),
    }
    if (searchDomainEndpoint) {
      environment.OPENSEARCH_URL = `https://${searchDomainEndpoint}`
      environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
    }
    if (config.domainName) {
      environment.BETTER_AUTH_URL = `https://${config.domainName}`
    }

    // Secrets injected into the container
    const containerSecrets: Record<string, ecs.Secret> = {
      ...database.buildPostgresSecrets(),
      BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
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
      serviceName: 'kukan-web',
      taskDefinition: taskDef,
      desiredCount: config.web.minSize,
      securityGroups: [webSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
    })

    // ALB (internet-facing, public subnets)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: cluster.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    })

    // HTTP Listener (open: false — SG rules managed by NetworkConstruct)
    // When Origin Verify is set, default action is 403; only CloudFront traffic
    // with the correct header is forwarded. ALB health checks bypass listener rules.
    const listener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      ...(originVerifyHeaderValue && {
        defaultAction: elbv2.ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Direct access is not allowed',
        }),
      }),
    })

    const targetGroup = listener.addTargets('WebTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      ...(originVerifyHeaderValue && {
        conditions: [
          elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [originVerifyHeaderValue]),
        ],
        priority: 1,
      }),
    })

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

    this.loadBalancerDnsName = alb.loadBalancerDnsName

    cdk.Tags.of(this).add('kukan:component', 'web-service')
  }
}
