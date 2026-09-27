/**
 * KUKAN Worker Service Construct
 * ECS Fargate service for the job queue (ADR-058). Its HTTP port answers the
 * health check and the web's wake signal, which reaches it by the name it
 * takes in the environment's Cloud Map namespace.
 */

import * as cdk from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as assets from 'aws-cdk-lib/aws-ecr-assets'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery'
import { WAITING_METRIC_NAME, WAITING_METRIC_NAMESPACE } from '@kukan/shared'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { envPrefix, resourceName } from '../naming.js'
import { configureBedrockEmbedding, configureBedrockCompletion } from './ai.js'
import type { DbAccess } from './database.js'

export interface WorkerServiceProps {
  config: KukanConfig
  cluster: ecs.ICluster
  workerSecurityGroup: ec2.ISecurityGroup
  database: DbAccess
  authSecret: secretsmanager.ISecret
  bucket: s3.IBucket
  /** Where the worker takes its name, for the web to wake it (ADR-058 §3). */
  serviceNamespace: servicediscovery.IPrivateDnsNamespace
  searchDomainEndpoint?: string
  /** Per-site OPENSEARCH_INDEX_PREFIX (ADR-041). Unset → app default (`kukan`). */
  searchIndexPrefix?: string
}

export class WorkerServiceConstruct extends Construct {
  readonly service: ecs.FargateService
  /** Where the web POSTs to wake this site's worker. */
  readonly wakeUrl: string
  private readonly workerContainer: ecs.ContainerDefinition

  /** Add an environment variable to the worker container after construction. */
  addEnvironment(key: string, value: string) {
    this.workerContainer.addEnvironment(key, value)
  }

  constructor(scope: Construct, id: string, props: WorkerServiceProps) {
    super(scope, id)

    const {
      config,
      cluster,
      workerSecurityGroup,
      database,
      authSecret,
      bucket,
      serviceNamespace,
      searchDomainEndpoint,
    } = props
    const serviceName = resourceName(this, 'worker')
    // The Site dimension of the metric it scales on (ADR-058 §4)
    const metricSite = envPrefix(this)
    const scales = config.worker.maxTasks > config.worker.minTasks

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
    // Environment variables
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      ...database.buildPostgresEnvironment(),
      S3_BUCKET: bucket.bucketName,
      S3_REGION: cdk.Aws.REGION,
      SEARCH_TYPE: searchDomainEndpoint ? 'opensearch' : 'postgres',
      WORKER_DB_POOL_MAX: String(config.dbPool.workerMax),
      HEALTH_PORT: String(config.worker.healthPort),
      // Only where there is a policy to read it: a custom metric is billed
      ...(scales && { WORKER_METRIC_SITE: metricSite }),
    }
    configureBedrockEmbedding(config, taskDef, environment)
    // Resource abstracts are written here, at the end of the pipeline (ADR-053).
    // Without a model to write them the worker generates no text at all, so it
    // is granted no generation models either.
    if (config.bedrock?.summaryModel) {
      configureBedrockCompletion(config, taskDef, environment)
    }
    if (searchDomainEndpoint) {
      environment.OPENSEARCH_URL = `https://${searchDomainEndpoint}`
      environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
      if (props.searchIndexPrefix) {
        environment.OPENSEARCH_INDEX_PREFIX = props.searchIndexPrefix
      }
    }

    // Container
    this.workerContainer = taskDef.addContainer('Worker', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      // The task's limit again, for the reason the web service gives.
      memoryLimitMiB: config.worker.memory,
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
      serviceName,
      taskDefinition: taskDef,
      // Pinned on purpose — see WebServiceConstruct: deploys reset to minTasks,
      // which the multi-site connection budget relies on.
      desiredCount: config.worker.minTasks,
      securityGroups: [workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      // An A record per task in the environment's namespace, for the web's
      // wake (ADR-058 §3). A short TTL: a deploy replaces the tasks, and a
      // signal sent to one that is gone is lost until the next.
      cloudMapOptions: {
        cloudMapNamespace: serviceNamespace,
        name: serviceName,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    })
    this.wakeUrl = `http://${serviceName}.${serviceNamespace.namespaceName}:${config.worker.healthPort}/wake`
    // The worker signals its own tasks too, for the jobs its jobs write: busy
    // with one, a task would otherwise hold them while another sat idle
    this.workerContainer.addEnvironment('WORKER_WAKE_URL', this.wakeUrl)

    // Auto Scaling (medium/large)
    if (scales) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: config.worker.minTasks,
        maxCapacity: config.worker.maxTasks,
      })
      // Jobs waiting to be taken, held ones included: counting only the
      // untaken, the service scales in with work still leased (ADR-058 §4).
      // Written once a minute by every task, 0 from an idle one, so the
      // series has no gaps for the policy to stall on.
      scaling.scaleOnMetric('JobsWaiting', {
        metric: new cloudwatch.Metric({
          namespace: WAITING_METRIC_NAMESPACE,
          metricName: WAITING_METRIC_NAME,
          dimensionsMap: { Site: metricSite },
          // A busy task reports the whole table's figure, its own held job
          // included, and an idle one 0: the highest is what the busy see
          statistic: cloudwatch.Stats.MAXIMUM,
          period: cdk.Duration.minutes(1),
        }),
        // Scale in only at zero. With held jobs counted, zero means nothing is
        // waiting and nothing is running, so a site with a steady trickle of
        // jobs stays scaled out after a burst — accepted, because scaling in
        // stops a task whatever it is doing, and stopTimeout does not cover a
        // long interpretation. A job cut off comes back when its lease runs out.
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
