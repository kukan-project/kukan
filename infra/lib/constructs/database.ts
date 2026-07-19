/**
 * KUKAN Database Construct
 * RDS PostgreSQL (small) or Aurora Serverless v2 (medium/large).
 * Credentials stored in Secrets Manager.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { envPrefix } from '../naming.js'

export interface DatabaseProps {
  config: KukanConfig
  vpc: ec2.IVpc
  dbSecurityGroup: ec2.ISecurityGroup
}

/**
 * Postgres connection surface consumed by the web/worker services. Satisfied by
 * DatabaseConstruct (single-site) and, under ADR-041, by a per-site credentials
 * wrapper — the services stay ignorant of which one they got.
 */
export interface DbAccess {
  /** Non-secret POSTGRES_* environment variables for ECS containers */
  buildPostgresEnvironment(): Record<string, string>
  /** POSTGRES_USER/PASSWORD as ECS secrets (injected at runtime via Secrets Manager) */
  buildPostgresSecrets(): Record<string, ecs.Secret>
}

export class DatabaseConstruct extends Construct {
  readonly secret: secretsmanager.ISecret
  readonly endpoint: string
  readonly port: number
  /** Cluster/instance ARN — AWS Backup selection target (ADR-037). */
  readonly dbArn: string

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id)

    const { config, vpc, dbSecurityGroup } = props

    if (config.db.engine === 'aurora') {
      const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
        clusterIdentifier: envPrefix(this),
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_6,
        }),
        serverlessV2MinCapacity: config.db.minAcu ?? 0,
        serverlessV2MaxCapacity: config.db.maxAcu ?? 2,
        writer: rds.ClusterInstance.serverlessV2('Writer'),
        ...(config.db.multiAz ? { readers: [rds.ClusterInstance.serverlessV2('Reader')] } : {}),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dbSecurityGroup],
        defaultDatabaseName: 'kukan',
        backup: { retention: cdk.Duration.days(config.backup.dbBackupRetentionDays) },
        removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
        storageEncrypted: true,
      })
      this.secret = cluster.secret!
      this.endpoint = cluster.clusterEndpoint.hostname
      this.port = cluster.clusterEndpoint.port
      this.dbArn = cluster.clusterArn
    } else {
      const instance = new rds.DatabaseInstance(this, 'RdsInstance', {
        instanceIdentifier: envPrefix(this),
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dbSecurityGroup],
        databaseName: 'kukan',
        multiAz: config.db.multiAz,
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        backupRetention: cdk.Duration.days(config.backup.dbBackupRetentionDays),
        storageEncrypted: true,
        removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      })
      this.secret = instance.secret!
      this.endpoint = instance.instanceEndpoint.hostname
      this.port = instance.instanceEndpoint.port
      this.dbArn = instance.instanceArn
    }

    cdk.Tags.of(this).add('kukan:component', 'database')
  }

  /** Non-secret POSTGRES_* environment variables for ECS containers */
  buildPostgresEnvironment(): Record<string, string> {
    return {
      POSTGRES_HOST: this.endpoint,
      POSTGRES_PORT: String(this.port),
      POSTGRES_DB: 'kukan',
      POSTGRES_SSLMODE: 'require',
    }
  }

  /** POSTGRES_USER/PASSWORD as ECS secrets (injected at runtime via Secrets Manager) */
  buildPostgresSecrets(): Record<string, ecs.Secret> {
    return {
      POSTGRES_USER: ecs.Secret.fromSecretsManager(this.secret, 'username'),
      POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(this.secret, 'password'),
    }
  }
}
