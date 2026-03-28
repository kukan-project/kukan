/**
 * KUKAN Main CDK Stack
 * Orchestrates all infrastructure constructs.
 */

import * as cdk from 'aws-cdk-lib'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import { loadConfig } from './config.js'
import { NetworkConstruct } from './constructs/network.js'
import { DatabaseConstruct } from './constructs/database.js'
import { StorageConstruct } from './constructs/storage.js'
import { QueueConstruct } from './constructs/queue.js'
import { SearchConstruct } from './constructs/search.js'
import { WebServiceConstruct } from './constructs/web-service.js'
import { WorkerServiceConstruct } from './constructs/worker-service.js'
import { CdnConstruct } from './constructs/cdn.js'

export interface KukanStackProps extends cdk.StackProps {
  /** ACM certificate ARN from KukanGlobalStack (us-east-1). Pass when domainName is set. */
  certArn?: string
  /** WAF WebACL ARN from KukanGlobalStack (us-east-1). Pass when enableWaf is true. */
  webAclArn?: string
}

export class KukanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KukanStackProps = {}) {
    super(scope, id, props)

    const { certArn, webAclArn } = props

    const config = loadConfig(this)

    // --- Network ---
    const network = new NetworkConstruct(this, 'Network', { config })

    // --- Database ---
    const database = new DatabaseConstruct(this, 'Database', {
      config,
      vpc: network.vpc,
      dbSecurityGroup: network.dbSecurityGroup,
    })

    // --- Auth Secret ---
    const authSecret = new secretsmanager.Secret(this, 'AuthSecret', {
      secretName: 'kukan-auth-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    })

    // --- Origin Verify Secret (CloudFront → App Runner) ---
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: 'kukan-origin-verify',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    })

    // --- Storage (S3) ---
    const storage = new StorageConstruct(this, 'Storage', { config })

    // --- Queue (SQS) ---
    const queue = new QueueConstruct(this, 'Queue')

    // --- Search (OpenSearch) ---
    let search: SearchConstruct | undefined
    if (config.enableOpenSearch) {
      search = new SearchConstruct(this, 'Search', {
        config,
        vpc: network.vpc,
        searchSecurityGroup: network.searchSecurityGroup,
      })
    }

    // Shared: DATABASE_URL built from Secrets Manager fields
    const databaseUrl = database.buildDatabaseUrl()

    // --- Web Service (App Runner) ---
    const webService = new WebServiceConstruct(this, 'WebService', {
      config,
      vpc: network.vpc,
      vpcConnectorSecurityGroup: network.appRunnerSecurityGroup,
      databaseUrl,
      authSecret,
      originVerifySecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
    })

    // --- Worker Service (ECS Fargate) ---
    new WorkerServiceConstruct(this, 'WorkerService', {
      config,
      vpc: network.vpc,
      workerSecurityGroup: network.workerSecurityGroup,
      databaseUrl,
      authSecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
    })

    // --- CDN (CloudFront + Route53 + ACM + WAF) ---
    if (config.enableCloudFront) {
      new CdnConstruct(this, 'Cdn', {
        config,
        appRunnerServiceUrl: webService.serviceUrl,
        certArn,
        webAclArn,
        originVerifySecret,
      })
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'WebServiceUrl', {
      value: webService.serviceUrl,
      description: 'App Runner Web Service URL',
    })
    new cdk.CfnOutput(this, 'BucketName', {
      value: storage.bucket.bucketName,
      description: 'S3 Bucket Name',
    })
  }
}
