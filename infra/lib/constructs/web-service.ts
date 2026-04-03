/**
 * KUKAN Web Service Construct
 * ECS Fargate service with ALB for Next.js web application.
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
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

export interface WebServiceProps {
  config: KukanConfig
  cluster: ecs.ICluster
  albSecurityGroup: ec2.ISecurityGroup
  webSecurityGroup: ec2.ISecurityGroup
  postgresEnv: Record<string, string>
  authSecret: secretsmanager.ISecret
  bucket: s3.IBucket
  queue: sqs.IQueue
  searchDomainEndpoint?: string
  /** ACM certificate for HTTPS listener. When omitted, HTTP listener is used. */
  certificate?: acm.ICertificate
}

export class WebServiceConstruct extends Construct {
  /** ALB ARN — used for WAF association. */
  readonly loadBalancerArn: string
  /** ALB DNS name — used for Route53 CNAME. */
  readonly loadBalancerDnsName: string

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id)

    const {
      config,
      cluster,
      albSecurityGroup,
      webSecurityGroup,
      postgresEnv,
      authSecret,
      bucket,
      queue,
      searchDomainEndpoint,
      certificate,
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
      ...postgresEnv,
      BETTER_AUTH_SECRET: authSecret.secretValue.unsafeUnwrap(),
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
    }
    if (config.domainName) {
      environment.BETTER_AUTH_URL = `https://${config.domainName}`
    }

    // Container
    taskDef.addContainer('Web', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      environment,
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

    // Listener: HTTPS with ACM cert, or HTTP for dev/test
    // open: false — all SG ingress rules managed by NetworkConstruct
    let listener: elbv2.ApplicationListener
    if (certificate) {
      listener = alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        open: false,
      })
      // HTTP → HTTPS redirect
      alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      })
    } else {
      listener = alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      })
    }

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

    this.loadBalancerArn = alb.loadBalancerArn
    this.loadBalancerDnsName = alb.loadBalancerDnsName

    cdk.Tags.of(this).add('kukan:component', 'web-service')
  }
}
