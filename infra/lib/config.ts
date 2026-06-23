/**
 * KUKAN CDK Configuration
 * Scale-based defaults for small / medium / large deployments,
 * resolved against a per-environment definition (see config/environments.ts, ADR-031).
 */

import type { Construct } from 'constructs'

export type Scale = 'small' | 'medium' | 'large'
export type DbEngine = 'rds' | 'aurora'

/** Default region when an environment does not specify one. */
export const DEFAULT_REGION = 'ap-northeast-1'

/** Sections computed from `scale`. These are overridable per environment via `overrides`. */
export interface ScaleComputed {
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
    /** Number of index replicas. Must be < instanceCount. */
    indexReplicas: number
  }
  dbPool: {
    webMax: number
    workerMax: number
  }
}

/** Recursive partial — used for `overrides` (fine-grained tuning on top of a scale preset). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/**
 * One entry per environment in `config/environments.ts` (ADR-031).
 * Only `account` is required (misdeployment guard); other fields fall back to
 * scale defaults / built-in defaults.
 */
export interface EnvironmentConfig {
  /**
   * Target AWS account ID. **Required** — pinning it makes CDK refuse to deploy when the
   * active credentials are for a different account, preventing accidental deploys to the
   * wrong account. Set it equal to your login account for same-account operation.
   */
  account: string
  /** Target region. Omit → ap-northeast-1. */
  region?: string
  scale?: Scale
  dbEngine?: DbEngine
  enableOpenSearch?: boolean
  enableWaf?: boolean
  allowedIpRanges?: string[]
  /**
   * Basic auth edge gate (CF Function), OR-combined with `allowedIpRanges`. Light gate
   * only — credentials are embedded (base64) in the readable CF Function source (ADR-027).
   */
  basicAuth?: { username: string; password: string }
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  /**
   * Pre-created us-east-1 ACM certificate ARN for CloudFront (ADR-030).
   * Supply this in pipeline mode to avoid cross-region references (which are
   * incompatible with CDK Pipelines). Create it once via a standalone
   * `cdk deploy -c env=<name> <Stage>/KukanGlobalStack`, then paste the ARN here.
   */
  certificateArn?: string
  /** Pre-created us-east-1 WAF WebACL ARN for CloudFront (see `certificateArn`). */
  webAclArn?: string
  /** S3 bucket name. Omit → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi?: boolean
  /** CodeConnections source repository in "owner/repo" form (ADR-030). */
  githubRepo?: string
  /** Branch that deploys this environment (ADR-030). */
  deployBranch?: string
  /** Fine-grained overrides of the scale preset. */
  overrides?: DeepPartial<ScaleComputed>
}

/**
 * Resolve the AWS environment (account/region) for an environment definition.
 * `account` is mandatory — the explicit account makes CDK reject deploys whose
 * active credentials target a different account (misdeployment guard, ADR-031).
 * Enforced at runtime too because tsx strips types without type-checking.
 */
export function resolveEnv(env: EnvironmentConfig): { account: string; region: string } {
  if (!env.account) {
    throw new Error(
      'EnvironmentConfig.account is required — set the target AWS account ID in ' +
        'config/environments.ts to prevent accidental deploys to the wrong account.'
    )
  }
  return { account: env.account, region: env.region ?? DEFAULT_REGION }
}

/** WAF default: ON unless an IP allowlist or Basic auth edge gate is set (ADR-027). */
export function resolveEnableWaf(env: EnvironmentConfig): boolean {
  return env.enableWaf ?? !(env.allowedIpRanges || env.basicAuth)
}

/**
 * Whether this environment must CREATE the us-east-1 global stack (ACM cert / WAF).
 * False when the ARNs are supplied (pipeline mode passes them as strings — ADR-030).
 */
export function needsGlobalStack(env: EnvironmentConfig): boolean {
  return (!!env.domainName && !env.certificateArn) || (resolveEnableWaf(env) && !env.webAclArn)
}

/** Fully-resolved configuration consumed by stacks and constructs. */
export interface KukanConfig extends ScaleComputed {
  scale: Scale
  dbEngine: DbEngine
  enableOpenSearch: boolean
  enableWaf: boolean
  allowedIpRanges?: string[]
  basicAuth?: { username: string; password: string }
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  /** undefined → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi: boolean
}

const SCALE_DEFAULTS: Record<Scale, ScaleComputed> = {
  small: {
    web: { cpu: 256, memory: 512, minSize: 1, maxSize: 2 },
    worker: { cpu: 256, memory: 1024, minTasks: 1, maxTasks: 2, healthPort: 8080 },
    db: { engine: 'rds', instanceClass: 'db.t4g.micro', multiAz: false },
    opensearch: {
      instanceType: 't3.small.search',
      instanceCount: 1,
      volumeSize: 10,
      multiAz: false,
      indexReplicas: 0,
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
      indexReplicas: 0,
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
      indexReplicas: 1,
    },
    dbPool: { webMax: 20, workerMax: 10 },
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge `override` onto `base` (arrays and primitives replace; objects merge). */
function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base
  const result = { ...base } as Record<string, unknown>
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key]
    const b = (base as Record<string, unknown>)[key]
    result[key] = isPlainObject(o) && isPlainObject(b) ? deepMerge(b, o) : o
  }
  return result as T
}

/**
 * Resolve the effective configuration.
 * Precedence: CLI `-c` context > environment entry > scale defaults > built-in defaults.
 */
export function loadConfig(scope: Construct, env: Partial<EnvironmentConfig> = {}): KukanConfig {
  const ctx = <T>(key: string): T | undefined => scope.node.tryGetContext(key) as T | undefined

  const scale = ctx<Scale>('scale') ?? env.scale ?? 'small'
  const base = SCALE_DEFAULTS[scale]

  const dbEngine = ctx<DbEngine>('dbEngine') ?? env.dbEngine ?? base.db.engine
  const enableOpenSearch = ctx<boolean>('enableOpenSearch') ?? env.enableOpenSearch ?? true
  const allowedIpRanges = ctx<string[]>('allowedIpRanges') ?? env.allowedIpRanges
  // env-only (no ctx): a credential must not live in committed cdk.json / shell history.
  const basicAuth = env.basicAuth
  // WAF provides managed rules on CloudFront scope (ADR-027). The edge gate (IP allowlist
  // and/or Basic auth) is handled by a CloudFront Function, so WAF defaults OFF when either
  // is set (saves ~$9/month).
  const enableWafExplicit = ctx<boolean>('enableWaf') ?? env.enableWaf
  const enableWaf = enableWafExplicit ?? !(allowedIpRanges || basicAuth)
  const domainName = ctx<string>('domainName') ?? env.domainName
  const hostedZoneId = ctx<string>('hostedZoneId') ?? env.hostedZoneId
  const hostedZoneName = ctx<string>('hostedZoneName') ?? env.hostedZoneName
  // undefined → CDK auto-naming (globally unique). ADR-031.
  const bucketName = ctx<string>('bucketName') ?? env.bucketName
  const enableGa4DataApi = ctx<boolean>('enableGa4DataApi') ?? env.enableGa4DataApi ?? false

  // Apply per-env overrides on top of the scale preset.
  const computed = deepMerge<ScaleComputed>(base, env.overrides)

  // Override DB engine.
  const db = { ...computed.db, engine: dbEngine }
  if (dbEngine === 'aurora' && db.minAcu == null) {
    db.minAcu = 0
    db.maxAcu = 2
  }

  // --- Consistency checks (catch broken override combinations at synth time) ---
  if (computed.opensearch.indexReplicas >= computed.opensearch.instanceCount) {
    throw new Error(
      `opensearch.indexReplicas (${computed.opensearch.indexReplicas}) must be < instanceCount (${computed.opensearch.instanceCount})`
    )
  }
  if (db.engine === 'aurora' && db.minAcu != null && db.maxAcu != null && db.minAcu > db.maxAcu) {
    throw new Error(`db.minAcu (${db.minAcu}) must be <= db.maxAcu (${db.maxAcu})`)
  }

  return {
    scale,
    dbEngine,
    enableOpenSearch,
    enableWaf,
    allowedIpRanges,
    basicAuth,
    domainName,
    hostedZoneId,
    hostedZoneName,
    bucketName,
    enableGa4DataApi,
    ...computed,
    db,
  }
}
