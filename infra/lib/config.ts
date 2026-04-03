/**
 * KUKAN CDK Configuration
 * Scale-based defaults for small / medium / large deployments.
 */

import type { Construct } from 'constructs'

export type Scale = 'small' | 'medium' | 'large'
export type DbEngine = 'rds' | 'aurora'

export interface KukanConfig {
  /** Deployment scale */
  scale: Scale
  /** Database engine */
  dbEngine: DbEngine
  /** Enable OpenSearch (false = PostgreSQL full-text fallback) */
  enableOpenSearch: boolean
  /** Enable WAF on ALB (managed rule groups + optional IP allowlist) */
  enableWaf: boolean
  /** IP allowlist (CIDR notation). When set, WAF blocks all other IPs. */
  allowedIpRanges?: string[]
  /** Custom domain name */
  domainName?: string
  /** Route53 Hosted Zone ID */
  hostedZoneId?: string
  /** Route53 Hosted Zone name */
  hostedZoneName?: string
  /** S3 bucket name for resource files. Default: 'kukan-resources'. */
  bucketName: string

  // --- Computed from scale ---
  web: {
    cpu: number // vCPU units (1024 = 1 vCPU)
    memory: number // MB
    minSize: number
    maxSize: number
  }
  worker: {
    cpu: number
    memory: number
    minTasks: number
    maxTasks: number
    healthPort: number
  }
  db: {
    engine: DbEngine
    // RDS
    instanceClass?: string
    // Aurora Serverless v2
    minAcu?: number
    maxAcu?: number
    // Common
    multiAz: boolean
  }
  opensearch: {
    instanceType: string
    instanceCount: number
    volumeSize: number // GB
    multiAz: boolean
  }
  dbPool: {
    webMax: number
    workerMax: number
  }
}

const SCALE_DEFAULTS: Record<
  Scale,
  Omit<
    KukanConfig,
    | 'scale'
    | 'dbEngine'
    | 'enableOpenSearch'
    | 'enableWaf'
    | 'allowedIpRanges'
    | 'domainName'
    | 'hostedZoneId'
    | 'hostedZoneName'
    | 'bucketName'
  >
> = {
  small: {
    web: { cpu: 256, memory: 512, minSize: 1, maxSize: 2 },
    worker: { cpu: 256, memory: 512, minTasks: 1, maxTasks: 1, healthPort: 8080 },
    db: { engine: 'rds', instanceClass: 'db.t4g.micro', multiAz: false },
    opensearch: {
      instanceType: 't3.small.search',
      instanceCount: 1,
      volumeSize: 10,
      multiAz: false,
    },
    dbPool: { webMax: 5, workerMax: 3 },
  },
  medium: {
    web: { cpu: 512, memory: 1024, minSize: 1, maxSize: 5 },
    worker: { cpu: 512, memory: 1024, minTasks: 1, maxTasks: 2, healthPort: 8080 },
    db: { engine: 'aurora', minAcu: 0.5, maxAcu: 2, multiAz: false },
    opensearch: {
      instanceType: 'm6g.large.search',
      instanceCount: 1,
      volumeSize: 50,
      multiAz: false,
    },
    dbPool: { webMax: 10, workerMax: 5 },
  },
  large: {
    web: { cpu: 1024, memory: 2048, minSize: 2, maxSize: 10 },
    worker: { cpu: 1024, memory: 2048, minTasks: 2, maxTasks: 5, healthPort: 8080 },
    db: { engine: 'aurora', minAcu: 2, maxAcu: 8, multiAz: true },
    opensearch: {
      instanceType: 'm6g.xlarge.search',
      instanceCount: 2,
      volumeSize: 100,
      multiAz: true,
    },
    dbPool: { webMax: 20, workerMax: 10 },
  },
}

export function loadConfig(scope: Construct): KukanConfig {
  const scale = (scope.node.tryGetContext('scale') as Scale) ?? 'small'
  const dbEngine =
    (scope.node.tryGetContext('dbEngine') as DbEngine) ?? SCALE_DEFAULTS[scale].db.engine
  const enableOpenSearch = scope.node.tryGetContext('enableOpenSearch') ?? true
  const allowedIpRanges = scope.node.tryGetContext('allowedIpRanges') as string[] | undefined
  // IP restriction is handled by ALB Security Group, so WAF is only needed
  // for managed rules. Default OFF when allowedIpRanges is set (saves ~$9/month).
  const enableWafExplicit = scope.node.tryGetContext('enableWaf') as boolean | undefined
  const enableWaf = enableWafExplicit ?? !allowedIpRanges
  const domainName = scope.node.tryGetContext('domainName') as string | undefined
  const hostedZoneId = scope.node.tryGetContext('hostedZoneId') as string | undefined
  const hostedZoneName = scope.node.tryGetContext('hostedZoneName') as string | undefined
  const bucketName = (scope.node.tryGetContext('bucketName') ?? 'kukan-resources') as string

  const defaults = SCALE_DEFAULTS[scale]

  // Override DB engine from context
  const db = { ...defaults.db, engine: dbEngine }
  if (dbEngine === 'aurora' && !db.minAcu) {
    db.minAcu = 0
    db.maxAcu = 2
  }

  return {
    scale,
    dbEngine,
    enableOpenSearch,
    enableWaf,
    allowedIpRanges,
    domainName,
    hostedZoneId,
    hostedZoneName,
    bucketName,
    ...defaults,
    db,
  }
}
