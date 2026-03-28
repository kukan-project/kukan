/**
 * KUKAN Web Service Construct
 * App Runner service (L2 alpha) with VPC Connector + DockerImageAsset.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as assets from 'aws-cdk-lib/aws-ecr-assets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import {
  Service,
  Source,
  Cpu,
  Memory,
  HealthCheck,
  VpcConnector,
  AutoScalingConfiguration,
} from '@aws-cdk/aws-apprunner-alpha'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface WebServiceProps {
  config: KukanConfig
  vpc: ec2.IVpc
  vpcConnectorSecurityGroup: ec2.ISecurityGroup
  databaseUrl: string
  authSecret: secretsmanager.ISecret
  originVerifySecret: secretsmanager.ISecret
  bucket: s3.IBucket
  queue: sqs.IQueue
  searchDomainEndpoint?: string
}

/** Map numeric CPU (from config) to L2 Cpu class */
function toCpu(value: number): Cpu {
  switch (value) {
    case 256:
      return Cpu.QUARTER_VCPU
    case 512:
      return Cpu.HALF_VCPU
    case 1024:
      return Cpu.ONE_VCPU
    case 2048:
      return Cpu.TWO_VCPU
    default:
      return Cpu.of(`${value}`)
  }
}

/** Map numeric memory MB (from config) to L2 Memory class */
function toMemory(value: number): Memory {
  switch (value) {
    case 512:
      return Memory.HALF_GB
    case 1024:
      return Memory.ONE_GB
    case 2048:
      return Memory.TWO_GB
    case 3072:
      return Memory.THREE_GB
    case 4096:
      return Memory.FOUR_GB
    default:
      return Memory.of(`${value}`)
  }
}

export class WebServiceConstruct extends Construct {
  readonly serviceUrl: string

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id)

    const {
      config,
      vpc,
      vpcConnectorSecurityGroup,
      databaseUrl,
      authSecret,
      originVerifySecret,
      bucket,
      queue,
      searchDomainEndpoint,
    } = props

    // Docker image (built and pushed automatically by CDK)
    const imageAsset = new assets.DockerImageAsset(this, 'WebImage', {
      directory: '../',
      file: 'Dockerfile',
      target: 'web',
      platform: assets.Platform.LINUX_AMD64,
    })

    // VPC Connector
    const vpcConnector = new VpcConnector(this, 'VpcConnector', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcConnectorSecurityGroup],
      vpcConnectorName: 'kukan-web-vpc',
    })

    // Auto Scaling Configuration
    const autoScaling = new AutoScalingConfiguration(this, 'AutoScaling', {
      autoScalingConfigurationName: 'kukan-web-scaling',
      minSize: config.web.minSize,
      maxSize: config.web.maxSize,
      maxConcurrency: 100,
    })

    // Environment variables
    const environmentVariables: Record<string, string> = {
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: authSecret.secretValue.unsafeUnwrap(),
      ORIGIN_VERIFY_SECRET: originVerifySecret.secretValue.unsafeUnwrap(),
      AI_TYPE: 'none',
      S3_BUCKET: bucket.bucketName,
      S3_REGION: cdk.Stack.of(this).region,
      SQS_REGION: cdk.Stack.of(this).region,
      SQS_QUEUE_URL: queue.queueUrl,
      SEARCH_TYPE: searchDomainEndpoint ? 'opensearch' : 'postgres',
      DB_POOL_MAX: String(config.dbPool.webMax),
    }
    if (searchDomainEndpoint) {
      environmentVariables.OPENSEARCH_URL = `https://${searchDomainEndpoint}`
    }
    if (config.domainName) {
      environmentVariables.BETTER_AUTH_URL = `https://${config.domainName}`
    }

    // App Runner Service (L2 alpha)
    const service = new Service(this, 'Service', {
      serviceName: 'kukan-web',
      source: Source.fromAsset({
        asset: imageAsset,
        imageConfiguration: {
          port: 3000,
          environmentVariables,
        },
      }),
      cpu: toCpu(config.web.cpu),
      memory: toMemory(config.web.memory),
      vpcConnector,
      autoScalingConfiguration: autoScaling,
      autoDeploymentsEnabled: true,
      healthCheck: HealthCheck.http({
        path: '/api/health',
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyThreshold: 1,
        unhealthyThreshold: 3,
      }),
    })

    // Grant runtime permissions
    bucket.grantReadWrite(service)
    queue.grantSendMessages(service)

    this.serviceUrl = `https://${service.serviceUrl}`

    cdk.Tags.of(this).add('kukan:component', 'web-service')
  }
}
