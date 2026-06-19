/**
 * KUKAN Worker Service Construct
 * ECS Fargate service for SQS-based pipeline processing.
 * Includes HTTP health check endpoint on port 8080.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as assets from 'aws-cdk-lib/aws-ecr-assets'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'
import type { DatabaseConstruct } from './database.js'

export interface WorkerServiceProps {
  config: KukanConfig
  cluster: ecs.ICluster
  workerSecurityGroup: ec2.ISecurityGroup
  database: DatabaseConstruct
  authSecret: secretsmanager.ISecret
  bucket: s3.IBucket
  queue: sqs.IQueue
  searchDomainEndpoint?: string
}

export class WorkerServiceConstruct extends Construct {
  readonly service: ecs.FargateService

  constructor(scope: Construct, id: string, props: WorkerServiceProps) {
    super(scope, id)

    const {
      config,
      cluster,
      workerSecurityGroup,
      database,
      authSecret,
      bucket,
      queue,
      searchDomainEndpoint,
    } = props

    // Docker image (built and pushed automatically by CDK).
    // CDK auto-loads the build context's .dockerignore into the asset-hash
    // exclude list, so it is the single source of truth. IgnoreMode.DOCKER makes
    // those patterns match like Docker (incl. nested node_modules); without it
    // the default GLOB mode misses nested node_modules and the hash churns on
    // every install, producing spurious image diffs.
    const imageAsset = new assets.DockerImageAsset(this, 'WorkerImage', {
      directory: '../',
      file: 'Dockerfile',
      target: 'worker',
      platform: assets.Platform.LINUX_AMD64,
      ignoreMode: cdk.IgnoreMode.DOCKER,
    })

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.worker.cpu,
      memoryLimitMiB: config.worker.memory,
    })

    // Grant permissions to task role
    bucket.grantReadWrite(taskDef.taskRole)
    queue.grantConsumeMessages(taskDef.taskRole)
    queue.grantSendMessages(taskDef.taskRole)
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
      WORKER_DB_POOL_MAX: String(config.dbPool.workerMax),
      HEALTH_PORT: String(config.worker.healthPort),
    }
    if (searchDomainEndpoint) {
      environment.OPENSEARCH_URL = `https://${searchDomainEndpoint}`
      environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
    }

    // Container
    taskDef.addContainer('Worker', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      environment,
      secrets: {
        ...database.buildPostgresSecrets(),
        BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
      },
      // Allow up to 120s for in-flight pipeline job to finish on SIGTERM (Fargate max)
      stopTimeout: cdk.Duration.seconds(120),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: new logs.LogGroup(this, 'WorkerLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        streamPrefix: 'worker',
      }),
      portMappings: [{ containerPort: config.worker.healthPort, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          'CMD-SHELL',
          `wget --no-verbose --tries=1 --spider http://localhost:${config.worker.healthPort}/health || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    })

    // Fargate Service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: resourceName(this, 'worker'),
      taskDefinition: taskDef,
      desiredCount: config.worker.minTasks,
      securityGroups: [workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
    })

    // Auto Scaling (medium/large)
    if (config.worker.maxTasks > config.worker.minTasks) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: config.worker.minTasks,
        maxCapacity: config.worker.maxTasks,
      })
      scaling.scaleOnMetric('QueueDepth', {
        metric: queue.metricApproximateNumberOfMessagesVisible(),
        scalingSteps: [
          { upper: 0, change: -1 },
          { lower: 5, change: +1 },
          { lower: 25, change: +2 },
        ],
        adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.seconds(300),
      })
    }

    cdk.Tags.of(this).add('kukan:component', 'worker-service')
  }
}
