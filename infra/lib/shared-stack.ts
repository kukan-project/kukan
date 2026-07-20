/**
 * KUKAN Shared Stack (ADR-041)
 * The hourly-billed boxes shared by all sites of a multi-site environment:
 * VPC/SGs, database cluster, OpenSearch domain, ECS cluster — plus the
 * SSM parameters SiteStacks read (deliberately no CloudFormation exports,
 * so shared-side changes are never locked by site references).
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { loadConfig, type EnvironmentConfig } from './config.js'
import { composeShared } from './composition.js'
import { sharedParamName } from './naming.js'
import { BackupConstruct } from './constructs/backup.js'

export interface KukanSharedStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig
}

export class KukanSharedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KukanSharedStackProps) {
    super(scope, id, props)

    // Site-specific fields live on the sites; the shared boxes are sized by
    // the environment entry alone.
    const config = loadConfig(this, props.envConfig)

    const shared = composeShared(this, config)
    const vpc = shared.network.vpc

    // DB half of AWS Backup (ADR-037): one plan here — a per-site plan would
    // snapshot the shared cluster once per site. Buckets back up per site.
    if (config.backup.awsBackup) {
      new BackupConstruct(this, 'Backup', { config, dbArn: shared.database.dbArn })
    }

    // SG granted into the DB — attached to each site's bootstrap Lambda
    // (SiteDatabaseConstruct). Kept here so sites never mutate shared SGs.
    const dbAccessSg = new ec2.SecurityGroup(this, 'SiteDbAccessSg', {
      vpc,
      description: 'Site DB bootstrap handlers (ADR-041)',
      allowAllOutbound: true,
    })
    shared.network.dbSecurityGroup.connections.allowFrom(
      dbAccessSg,
      ec2.Port.tcp(5432),
      'Site DB bootstrap'
    )

    // The VPC has no NAT and the bootstrap handlers run in the isolated
    // subnets — Secrets Manager is only reachable through this endpoint.
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    })

    const param = (suffix: string, value: string) =>
      new ssm.StringParameter(this, `Param${suffix.replaceAll(/[/-]/g, '')}`, {
        parameterName: sharedParamName(this, suffix),
        stringValue: value,
      })

    param('vpc/id', vpc.vpcId)
    param('vpc/azs', cdk.Fn.join(',', vpc.availabilityZones))
    param(
      'vpc/public-subnet-ids',
      cdk.Fn.join(
        ',',
        vpc.publicSubnets.map((s) => s.subnetId)
      )
    )
    param(
      'vpc/isolated-subnet-ids',
      cdk.Fn.join(
        ',',
        vpc.isolatedSubnets.map((s) => s.subnetId)
      )
    )
    param('sg/alb', shared.network.albSecurityGroup.securityGroupId)
    param('sg/web', shared.network.webSecurityGroup.securityGroupId)
    param('sg/worker', shared.network.workerSecurityGroup.securityGroupId)
    param('sg/db-access', dbAccessSg.securityGroupId)
    param('ecs/cluster-name', shared.cluster.clusterName)
    param('db/endpoint', shared.database.endpoint)
    param('db/port', cdk.Tokenization.stringifyNumber(shared.database.port))
    param('db/master-secret-arn', shared.database.secret.secretArn)
    if (shared.search) {
      param('search/endpoint', shared.search.domainEndpoint)
    }
  }
}
