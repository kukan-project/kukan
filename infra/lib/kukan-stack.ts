/**
 * KUKAN Main CDK Stack
 * Orchestrates all infrastructure constructs.
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import type { Construct } from 'constructs'
import { loadConfig } from './config.js'
import { NetworkConstruct } from './constructs/network.js'
import { DatabaseConstruct } from './constructs/database.js'
import { StorageConstruct } from './constructs/storage.js'
import { QueueConstruct } from './constructs/queue.js'
import { SearchConstruct } from './constructs/search.js'
import { WebServiceConstruct } from './constructs/web-service.js'
import { WorkerServiceConstruct } from './constructs/worker-service.js'
import { WafConstruct } from './constructs/waf.js'

export class KukanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
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
      secretName: 'kukan-auth-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
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

    // Shared: POSTGRES_* env vars from Secrets Manager
    const postgresEnv = database.buildPostgresEnv()

    // --- ECS Cluster (shared by Web + Worker) ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      clusterName: 'kukan',
    })

    // --- Custom Domain (ACM + Route53) ---
    let certificate: acm.ICertificate | undefined
    let hostedZone: route53.IHostedZone | undefined
    if (config.domainName && config.hostedZoneId && config.hostedZoneName) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      })

      certificate = new acm.Certificate(this, 'Certificate', {
        domainName: config.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      })
    }

    // --- Web Service (ECS Fargate + ALB) ---
    const webService = new WebServiceConstruct(this, 'WebService', {
      config,
      cluster,
      albSecurityGroup: network.albSecurityGroup,
      webSecurityGroup: network.webSecurityGroup,
      postgresEnv,
      authSecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
      certificate,
    })

    // --- Worker Service (ECS Fargate) ---
    new WorkerServiceConstruct(this, 'WorkerService', {
      config,
      cluster,
      workerSecurityGroup: network.workerSecurityGroup,
      postgresEnv,
      authSecret,
      bucket: storage.bucket,
      queue: queue.queue,
      searchDomainEndpoint: search?.domainEndpoint,
    })

    // --- WAF (optional, REGIONAL scope for ALB) ---
    if (config.enableWaf) {
      const waf = new WafConstruct(this, 'Waf')
      new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
        resourceArn: webService.loadBalancerArn,
        webAclArn: waf.webAcl.attrArn,
      })
    }

    // --- DNS Record ---
    if (hostedZone && config.domainName) {
      new route53.CnameRecord(this, 'DnsRecord', {
        zone: hostedZone,
        recordName: config.domainName,
        domainName: webService.loadBalancerDnsName,
      })
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'WebServiceUrl', {
      value: webService.loadBalancerDnsName,
      description: 'ALB DNS Name',
    })
    new cdk.CfnOutput(this, 'BucketName', {
      value: storage.bucket.bucketName,
      description: 'S3 Bucket Name',
    })
  }
}
