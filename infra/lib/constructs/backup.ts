/**
 * KUKAN Backup Construct (ADR-037)
 * AWS Backup vault + plan for the resource bucket and the database.
 *
 * The vault is RETAINed: a vault holding recovery points cannot be deleted, so
 * disabling `backup.awsBackup` orphans the vault (new backups stop, existing
 * recovery points expire on their own lifecycle) instead of failing the stack
 * update. The vault name is fixed (kukan-<env>-backup; per-site stacks get
 * kukan-<env>-<site>-backup), so re-enabling while the retained vault still
 * exists collides — delete the old vault (once empty) before re-enabling.
 */

import * as cdk from 'aws-cdk-lib'
import * as backup from 'aws-cdk-lib/aws-backup'
import * as events from 'aws-cdk-lib/aws-events'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'

export interface BackupProps {
  config: KukanConfig
  /** Resource file bucket (versioning required — enforced in loadConfig).
   *  Omitted in the multi-site SharedStack (DB only, ADR-041). */
  bucket?: s3.IBucket
  /** RDS instance / Aurora cluster ARN.
   *  Omitted in the multi-site SiteStack (bucket only, ADR-041). */
  dbArn?: string
}

export class BackupConstruct extends Construct {
  constructor(scope: Construct, id: string, props: BackupProps) {
    super(scope, id)

    const { config, bucket, dbArn } = props
    const awsBackup = config.backup.awsBackup
    if (!awsBackup) {
      throw new Error('BackupConstruct requires backup.awsBackup to be enabled')
    }
    if (!bucket && !dbArn) {
      throw new Error('BackupConstruct requires a bucket and/or a dbArn')
    }

    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: resourceName(this, 'backup'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // S3 backup/restore need their own managed policies on top of the base ones.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSBackupServiceRolePolicyForBackup'
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSBackupServiceRolePolicyForRestores'
        ),
        ...(bucket
          ? [
              iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Backup'),
              iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Restore'),
            ]
          : []),
      ],
    })

    const plan = new backup.BackupPlan(this, 'Plan', {
      backupPlanName: resourceName(this, 'backup'),
      backupVault: vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'Daily',
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '18' }), // 03:00 JST
          deleteAfter: cdk.Duration.days(awsBackup.dailyRetentionDays),
        }),
        ...(awsBackup.monthlyRetentionMonths > 0
          ? [
              new backup.BackupPlanRule({
                ruleName: 'Monthly',
                scheduleExpression: events.Schedule.cron({ minute: '0', hour: '18', day: '1' }),
                deleteAfter: cdk.Duration.days(awsBackup.monthlyRetentionMonths * 31),
              }),
            ]
          : []),
      ],
    })

    plan.addSelection('Selection', {
      role,
      resources: [
        ...(bucket ? [backup.BackupResource.fromArn(bucket.bucketArn)] : []),
        ...(dbArn ? [backup.BackupResource.fromArn(dbArn)] : []),
      ],
    })

    cdk.Tags.of(this).add('kukan:component', 'backup')
  }
}
