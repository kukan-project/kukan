/**
 * KUKAN Site Stack (ADR-041)
 * One site's resources on the shared boxes: site database + role, S3 bucket,
 * SQS queue, ECS web/worker services, CloudFront (+ domain), secrets, logs.
 * Reads the shared surface from SSM parameters written by KukanSharedStack —
 * never CloudFormation exports.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { resolveSiteConfig, type EnvironmentConfig, type SiteConfig } from './config.js'
import { composeSite } from './composition.js'
import { envPrefix, sharedParamName, type SiteScopedStack } from './naming.js'
import { BackupConstruct } from './constructs/backup.js'
import { SiteDatabaseConstruct } from './constructs/site-database.js'

export interface KukanSiteStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig
  site: SiteConfig
  /** Site's viewer certificate ARN (pasted, or created in KukanGlobalStack). */
  globalCertificateArn?: string
  /** Site's WAF WebACL ARN (pasted, or the shared one from KukanGlobalStack). */
  globalWebAclArn?: string
}

export class KukanSiteStack extends cdk.Stack implements SiteScopedStack {
  /** Extends every resourceName()/envPrefix() result to kukan-<env>-<site>-*. */
  readonly kukanSiteName: string

  constructor(scope: Construct, id: string, props: KukanSiteStackProps) {
    super(scope, id, props)
    this.kukanSiteName = props.site.name

    const config = resolveSiteConfig(this, props.envConfig, props.site)

    // Deploy-time SSM resolution (CFN parameter type AWS::SSM::Parameter::Value).
    // Not valueFromLookup — its synth-time context cache would go stale when the
    // shared boxes change (ADR-041).
    const read = (suffix: string) =>
      ssm.StringParameter.valueForStringParameter(this, sharedParamName(this, suffix))

    // NetworkConstruct pins maxAzs: 2, so every list has exactly 2 entries —
    // the assumed length Fn.split needs to work with deploy-time tokens.
    const splitPair = (value: string) => cdk.Fn.split(',', value, 2)
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'SharedVpc', {
      vpcId: read('vpc/id'),
      availabilityZones: splitPair(read('vpc/azs')),
      publicSubnetIds: splitPair(read('vpc/public-subnet-ids')),
      isolatedSubnetIds: splitPair(read('vpc/isolated-subnet-ids')),
    })
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'SharedCluster', {
      clusterName: read('ecs/cluster-name'),
      vpc,
    })
    const importSg = (importId: string, suffix: string) =>
      ec2.SecurityGroup.fromSecurityGroupId(this, importId, read(suffix), { mutable: false })

    const siteDatabase = new SiteDatabaseConstruct(this, 'SiteDatabase', {
      siteName: props.site.name,
      dbHost: read('db/endpoint'),
      dbPort: read('db/port'),
      masterSecretArn: read('db/master-secret-arn'),
      vpc,
      dbAccessSecurityGroup: importSg('DbAccessSg', 'sg/db-access'),
    })

    const site = composeSite(
      this,
      config,
      {
        cluster,
        albSecurityGroup: importSg('AlbSg', 'sg/alb'),
        webSecurityGroup: importSg('WebSg', 'sg/web'),
        workerSecurityGroup: importSg('WorkerSg', 'sg/worker'),
        db: siteDatabase,
        searchDomainEndpoint: config.enableOpenSearch ? read('search/endpoint') : undefined,
        // kukan-<env>-<site> → index kukan-<env>-<site>-search on the shared domain
        searchIndexPrefix: envPrefix(this),
        // 'default' == unset: no build arg → resolved via the @/brand tsconfig path (ADR-042)
        webImageBuildArgs:
          props.site.brand && props.site.brand !== 'default'
            ? { KUKAN_BRAND: props.site.brand }
            : undefined,
      },
      {
        certificateArn: props.globalCertificateArn,
        webAclArn: props.globalWebAclArn,
      }
    )

    // Tasks run drizzle migrations at startup — the database must exist first
    site.webService.node.addDependency(siteDatabase.customResource)
    site.workerService.node.addDependency(siteDatabase.customResource)

    // Bucket half of AWS Backup (ADR-037) — own vault kukan-<env>-<site>-backup;
    // the shared DB plan lives in KukanSharedStack
    if (config.backup.awsBackup) {
      new BackupConstruct(this, 'Backup', { config, bucket: site.bucket })
    }
  }
}
