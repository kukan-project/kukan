/**
 * KUKAN Main CDK Stack
 * All-in-one single-site stack: shared boxes + one site's resources,
 * composed by the plain functions in composition.ts (ADR-041).
 *
 * CloudFront is always deployed as the front-facing layer (ADR-027).
 * CloudFront connects to the internal ALB via VPC origin — no public IPs on ALB.
 * TLS termination, WAF, and caching are handled at CloudFront.
 */

import * as cdk from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { loadConfig, type EnvironmentConfig } from '../config.js'
import { composeShared, composeSite } from './composition.js'
import { BackupConstruct } from '../constructs/backup.js'
import { envPrefix } from '../naming.js'
import { DEFAULT_OPENSEARCH_INDEX_PREFIX } from '@kukan/shared/env'

export interface KukanStackProps extends cdk.StackProps {
  /** Environment definition for this stack (ADR-031). */
  envConfig?: EnvironmentConfig
  /** CloudFront viewer certificate ARN from KukanGlobalStack (us-east-1). */
  globalCertificateArn?: string
  /** WAF WebACL ARN from KukanGlobalStack (us-east-1). */
  globalWebAclArn?: string
}

export class KukanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KukanStackProps = {}) {
    super(scope, id, props)

    const config = loadConfig(this, props.envConfig)

    // The one site runs with the app's default index prefix
    const shared = composeShared(this, config, [
      { sitePrefix: envPrefix(this), indexPrefix: DEFAULT_OPENSEARCH_INDEX_PREFIX },
    ])

    const site = composeSite(
      this,
      config,
      {
        cluster: shared.cluster,
        serviceNamespace: shared.serviceNamespace,
        albSecurityGroup: shared.network.albSecurityGroup,
        webSecurityGroup: shared.network.webSecurityGroup,
        workerSecurityGroup: shared.network.workerSecurityGroup,
        db: shared.database,
        searchDomain: shared.search?.ref,
      },
      {
        certificateArn: props.globalCertificateArn,
        webAclArn: props.globalWebAclArn,
      }
    )

    // AWS Backup spans shared (DB cluster) and site (bucket) resources, so it
    // lives here rather than in either composition; multi-site splits it into
    // the shared (DB) and site (bucket) stacks (ADR-037 / ADR-041).
    if (config.backup.awsBackup) {
      new BackupConstruct(this, 'Backup', {
        config,
        bucket: site.bucket,
        dbArn: shared.database.dbArn,
      })
    }
  }
}
