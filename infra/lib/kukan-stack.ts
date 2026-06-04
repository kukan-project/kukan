/**
 * KUKAN Main CDK Stack
 * Orchestrates all infrastructure constructs.
 *
 * CloudFront is always deployed as the front-facing layer (ADR-027).
 * TLS termination, WAF, and caching are handled at CloudFront;
 * ALB receives HTTP traffic only.
 */

import * as cdk from 'aws-cdk-lib'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
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
  /** CloudFront viewer certificate ARN from KukanGlobalStack (us-east-1). */
  globalCertificateArn?: string
  /** WAF WebACL ARN from KukanGlobalStack (us-east-1). */
  globalWebAclArn?: string
}

export class KukanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KukanStackProps = {}) {
    super(scope, id, props)

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
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    })

    // --- Origin Verify Secret (shared between ALB listener rule and CloudFront) ---
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
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

    // --- ECS Cluster (shared by Web + Worker) ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      clusterName: 'kukan',
    })

    // --- Web Service (ECS Fargate + ALB, HTTP only) ---
    // CloudFront terminates TLS; ALB does not need an ACM certificate.
    // Origin Verify is enforced at the ALB listener rule level (ADR-027).
    const webService = new WebServiceConstruct(this, 'WebService', {
      config,
      cluster,
      albSecurityGroup: network.albSecurityGroup,
      webSecurityGroup: network.webSecurityGroup,
      database,
      authSecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
      originVerifyHeaderValue: originVerifySecret.secretValue.unsafeUnwrap(),
    })

    // --- Worker Service (ECS Fargate) ---
    new WorkerServiceConstruct(this, 'WorkerService', {
      config,
      cluster,
      workerSecurityGroup: network.workerSecurityGroup,
      database,
      authSecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
    })

    // --- CDN (CloudFront) ---
    const cdn = new CdnConstruct(this, 'CDN', {
      config,
      albDnsName: webService.loadBalancerDnsName,
      originVerifySecret,
      certificateArn: props.globalCertificateArn,
      webAclArn: props.globalWebAclArn,
    })

    // Set BETTER_AUTH_URL to CloudFront domain when no custom domain
    if (!config.domainName) {
      webService.addEnvironment('BETTER_AUTH_URL', `https://${cdn.distributionDomainName}`)
    }

    // --- DNS Record (A Alias → CloudFront) ---
    if (config.domainName && config.hostedZoneId && config.hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      })

      new route53.ARecord(this, 'DnsRecord', {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(cdn.distribution)
        ),
      })
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: cdn.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
    })
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: webService.loadBalancerDnsName,
      description: 'ALB DNS Name (internal, behind CloudFront)',
    })
    new cdk.CfnOutput(this, 'BucketName', {
      value: storage.bucket.bucketName,
      description: 'S3 Bucket Name',
    })
  }
}
