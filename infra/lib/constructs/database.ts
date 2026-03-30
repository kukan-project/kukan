/**
 * KUKAN Database Construct
 * RDS PostgreSQL (small) or Aurora Serverless v2 (medium/large).
 * Credentials stored in Secrets Manager.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface DatabaseProps {
  config: KukanConfig
  vpc: ec2.IVpc
  dbSecurityGroup: ec2.ISecurityGroup
}

export class DatabaseConstruct extends Construct {
  readonly secret: secretsmanager.ISecret
  readonly endpoint: string
  readonly port: number

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id)

    const { config, vpc, dbSecurityGroup } = props

    if (config.db.engine === 'aurora') {
      const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_6,
        }),
        serverlessV2MinCapacity: config.db.minAcu ?? 0,
        serverlessV2MaxCapacity: config.db.maxAcu ?? 2,
        writer: rds.ClusterInstance.serverlessV2('Writer'),
        ...(config.db.multiAz ? { readers: [rds.ClusterInstance.serverlessV2('Reader')] } : {}),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSecurityGroup],
        defaultDatabaseName: 'kukan',
        removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
        storageEncrypted: true,
      })
      this.secret = cluster.secret!
      this.endpoint = cluster.clusterEndpoint.hostname
      this.port = cluster.clusterEndpoint.port
    } else {
      const instance = new rds.DatabaseInstance(this, 'RdsInstance', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSecurityGroup],
        databaseName: 'kukan',
        multiAz: config.db.multiAz,
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        storageEncrypted: true,
        removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      })
      this.secret = instance.secret!
      this.endpoint = instance.instanceEndpoint.hostname
      this.port = instance.instanceEndpoint.port
    }

    cdk.Tags.of(this).add('kukan:component', 'database')
  }

  /** Build POSTGRES_* env vars from Secrets Manager secret */
  buildPostgresEnv(): Record<string, string> {
    return {
      POSTGRES_HOST: this.endpoint,
      POSTGRES_PORT: String(this.port),
      POSTGRES_DB: 'kukan',
      POSTGRES_USER: this.secret.secretValueFromJson('username').unsafeUnwrap(),
      POSTGRES_PASSWORD: this.secret.secretValueFromJson('password').unsafeUnwrap(),
      POSTGRES_SSLMODE: 'require',
    }
  }
}
