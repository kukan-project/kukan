/**
 * KUKAN Site Database Construct (ADR-041)
 * Per-site PostgreSQL database + role on the shared cluster, created by a
 * Lambda-backed Custom Resource (CDK cannot create in-database objects).
 */

import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import type { DbAccess } from './database.js'

export interface SiteDatabaseProps {
  /** Validated site name (config.validateSites) — becomes `kukan_<site>` in PostgreSQL. */
  siteName: string
  /** Shared cluster endpoint hostname (SSM-imported token). */
  dbHost: string
  /** Shared cluster port (SSM-imported token). */
  dbPort: string
  /** Master credentials secret ARN (SSM-imported token). */
  masterSecretArn: string
  /** Shared VPC (imported) — the handler must reach the isolated DB subnets. */
  vpc: ec2.IVpc
  /** Shared SG allowed into the DB on 5432 (created by KukanSharedStack). */
  dbAccessSecurityGroup: ec2.ISecurityGroup
}

/**
 * Creates the site's Secrets Manager credentials and converges the database/
 * role via the Custom Resource. Implements DbAccess so composeSite can wire the
 * web/worker containers exactly like the single-site DatabaseConstruct.
 */
export class SiteDatabaseConstruct extends Construct implements DbAccess {
  /** Site credentials secret ({ username, password, dbname }). */
  readonly secret: secretsmanager.ISecret
  /** `kukan_<site>` — database name and role name. */
  readonly dbName: string
  private readonly dbHost: string
  private readonly dbPort: string
  private readonly resource: cdk.CustomResource

  constructor(scope: Construct, id: string, props: SiteDatabaseProps) {
    super(scope, id)

    this.dbName = `kukan_${props.siteName}`
    this.dbHost = props.dbHost
    this.dbPort = props.dbPort

    // Password never appears in the template — generated server-side
    this.secret = new secretsmanager.Secret(this, 'Secret', {
      description: `KUKAN site DB credentials (${props.siteName})`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: this.dbName, dbname: this.dbName }),
        generateStringKey: 'password',
        // Safe inside a SQL string literal and a connection URL
        excludeCharacters: ` '"\\/@%&+:;?#[]()<>{}|`,
        passwordLength: 48,
      },
    })

    const handler = new lambdaNodejs.NodejsFunction(this, 'Handler', {
      entry: fileURLToPath(new URL('../lambda/site-db-handler/index.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      logRetention: logs.RetentionDays.ONE_MONTH,
      // The VPC has no NAT; Secrets Manager is reachable via the interface
      // endpoint created by KukanSharedStack
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbAccessSecurityGroup],
      bundling: { minify: false, sourcesContent: false },
    })
    // Token ARNs can't go through Secret.fromSecretCompleteArn (synth-time parse)
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.masterSecretArn, this.secret.secretArn],
      })
    )

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: handler,
      logRetention: logs.RetentionDays.ONE_MONTH,
    })

    this.resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::KukanSiteDatabase',
      properties: {
        MasterSecretArn: props.masterSecretArn,
        SiteSecretArn: this.secret.secretArn,
        DbHost: props.dbHost,
        DbPort: props.dbPort,
        DbName: this.dbName,
        RoleName: this.dbName,
      },
    })
  }

  /** Anchor for `node.addDependency` — tasks must not start before the DB exists. */
  get customResource(): cdk.CustomResource {
    return this.resource
  }

  buildPostgresEnvironment(): Record<string, string> {
    return {
      POSTGRES_HOST: this.dbHost,
      POSTGRES_PORT: this.dbPort,
      POSTGRES_DB: this.dbName,
      POSTGRES_SSLMODE: 'require',
    }
  }

  buildPostgresSecrets(): Record<string, ecs.Secret> {
    return {
      POSTGRES_USER: ecs.Secret.fromSecretsManager(this.secret, 'username'),
      POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(this.secret, 'password'),
    }
  }
}
