/**
 * KUKAN CDK Configuration
 * Scale-based defaults for small / medium / large deployments,
 * resolved against a per-environment definition (see config/environments.ts, ADR-031).
 */

import type { Construct } from 'constructs'
// Resolves to dist/ — the cdk.json app command builds @kukan/shared first so
// synth works on a clean checkout (the pipeline runs no workspace build)
import { DEFAULT_BEDROCK_COMPLETION_MODEL } from '@kukan/shared/ai'

export type Scale = 'small' | 'medium' | 'large'
export type DbEngine = 'rds' | 'aurora'

/** Default region when an environment does not specify one. */
export const DEFAULT_REGION = 'ap-northeast-1'

/** Matches the bedrock adapter's default (packages/adapters/ai). Resolved here so
 *  the container env and the IAM model scope always agree. */
export const DEFAULT_BEDROCK_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'

/** Resolve completionModels with a fail-fast guard, normalized to match runtime.
 *  The adapter trims+dedupes these IDs before invoking (adapters.ts), so the IAM
 *  scope must too — otherwise a stray-whitespace ID grants one ARN while the call
 *  uses another, failing with IAM denial. An empty list or blank entry grants no
 *  IAM yet the adapter still falls back to a model, so reject it at synth instead.
 *  Omit → default. */
function resolveCompletionModels(models: string[] | undefined): string[] {
  if (models === undefined) return [DEFAULT_BEDROCK_COMPLETION_MODEL]
  const normalized = [...new Set(models.map((m) => m.trim()))]
  if (normalized.length === 0 || normalized.some((m) => !m)) {
    throw new Error(
      'bedrock.completionModels must be a non-empty list of model IDs (omit it to use the default)'
    )
  }
  return normalized
}

/** Bedrock embedding for semantic search (ADR-034). Presence enables it. */
export interface BedrockConfig {
  /** Bedrock API region. Omit → the deployment region. */
  region?: string
  /** Embedding model ID. Omit → Titan Text Embeddings v2. */
  embeddingModel?: string
  /** Embedding dimensions. Omit → adapter default (1024). */
  embeddingDimensions?: number
  /** Cosine similarity floor override. Omit → the model's golden-set-measured
   *  recommendation, held by the AI adapter (Titan 0.15 / Cohere 0.3). */
  vectorMinSimilarity?: number
  /** Completion models the task role may invoke (ADR-040); also the admin
   *  model-picker options. Omit → the default Nova Lite profile. Changing needs redeploy. */
  completionModels?: string[]
}

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
  backup: {
    /** S3 versioning (delete/overwrite protection; required for AWS Backup on S3). ADR-037. */
    s3Versioning: boolean
    /** Days to keep noncurrent object versions (bounds versioning storage cost). */
    s3NoncurrentVersionExpirationDays: number
    /** RDS/Aurora automated backup retention = PITR window, days (1–35). */
    dbBackupRetentionDays: number
    /** AWS Backup plan (isolated vault, daily/monthly snapshots). false = disabled.
     *  The vault (kukan-<env>-backup) is RETAINed on disable; delete it manually
     *  once empty before re-enabling (ADR-037). */
    awsBackup: false | { dailyRetentionDays: number; monthlyRetentionMonths: number }
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
  /**
   * Bedrock embedding for semantic search (ADR-034). Omit → enabled with Titan v2
   * defaults; `false` → AI disabled (AI_TYPE=none). No console setup needed —
   * serverless foundation models auto-enable on first invocation; the task-role
   * IAM policy added here is the only access gate.
   */
  bedrock?: BedrockConfig | false
  /** CodeConnections source repository in "owner/repo" form (ADR-030). */
  githubRepo?: string
  /** Branch that deploys this environment (ADR-030). */
  deployBranch?: string
  /** Fine-grained overrides of the scale preset. */
  overrides?: DeepPartial<ScaleComputed>
  /**
   * Sites hosted by this environment (ADR-041). Presence (non-empty) opts the
   * environment into the SharedStack/SiteStack split; absence keeps the
   * all-in-one KukanStack with unchanged logical IDs. Existing single-site
   * environments migrate blue/green only — never by adding `sites` in place.
   */
  sites?: SiteConfig[]
}

/**
 * One site inside a multi-site environment (ADR-041). Undeclared aspects
 * (scale, dbEngine, enableOpenSearch, bedrock, …) are shared-box territory and
 * always come from the environment entry.
 */
export interface SiteConfig {
  /**
   * Site key: lowercase alphanumeric, 2–16 chars, no hyphens (used in resource
   * names `kukan-<env>-<site>-*` AND PostgreSQL identifiers `kukan_<site>`).
   */
  name: string
  /**
   * Web image brand (ADR-042): passed to the Docker build as `KUKAN_BRAND`.
   * Leave unset until the Dockerfile consumes that ARG (ADR-042 implementation)
   * — an unknown build arg fails the image build at asset publish time.
   */
  brand?: string
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  /**
   * Pre-created us-east-1 ACM certificate ARN. Required when `domainName` is
   * set — multi-site environments never create the global stack themselves, in
   * standalone mode too (one cert per site domain; create it via the console or
   * a one-off standalone GlobalStack deploy, then paste the ARN).
   */
  certificateArn?: string
  /** Pre-created us-east-1 WAF WebACL ARN. May be shared by several sites. */
  webAclArn?: string
  enableWaf?: boolean
  allowedIpRanges?: string[]
  basicAuth?: { username: string; password: string }
  /** S3 bucket name. Omit → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi?: boolean
  /**
   * Per-site sizing on top of the environment's scale preset. Only the
   * site-owned sections — db/opensearch sizing belongs to the shared boxes,
   * and AWS Backup plans are rejected per site (the shared cluster would be
   * snapshotted once per site; use per-site pg_dump instead, ADR-041).
   */
  overrides?: DeepPartial<Pick<ScaleComputed, 'web' | 'worker' | 'dbPool' | 'backup'>>
}

const SITE_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}$/

/**
 * Validate the `sites` list of a multi-site environment. Throws at synth with
 * an actionable message — misconfiguration must never reach CloudFormation.
 * Returns a warning message (for cdk.Annotations) when the connection budget
 * passes but exceeds 70% of the estimate.
 */
export function validateSites(env: EnvironmentConfig): string | undefined {
  const sites = env.sites ?? []
  if (sites.length === 0) return
  if (env.domainName || env.certificateArn || env.webAclArn) {
    throw new Error(
      'Multi-site environments declare domains/certificates per site — remove ' +
        'domainName/certificateArn/webAclArn from the environment entry (ADR-041)'
    )
  }
  const envComputed = deepMerge(SCALE_DEFAULTS[env.scale ?? 'small'], env.overrides)
  if (envComputed.backup.awsBackup) {
    throw new Error(
      'Multi-site environments must disable AWS Backup (the shared DB cluster ' +
        'would be snapshotted once per site) — set overrides: { backup: ' +
        '{ awsBackup: false } } on the environment and use per-site pg_dump ' +
        'instead (ADR-041)'
    )
  }
  const seen = new Set<string>()
  for (const site of sites) {
    if (!SITE_NAME_PATTERN.test(site.name)) {
      throw new Error(
        `Site name "${site.name}" must match ${SITE_NAME_PATTERN} — it is used in ` +
          'resource names and PostgreSQL identifiers'
      )
    }
    if (site.name === 'shared') {
      throw new Error('Site name "shared" is reserved (ADR-041)')
    }
    if (seen.has(site.name)) {
      throw new Error(`Duplicate site name "${site.name}"`)
    }
    seen.add(site.name)
    if (site.domainName && !site.certificateArn) {
      throw new Error(
        `Site "${site.name}" sets domainName but no certificateArn. Multi-site ` +
          'environments never create the us-east-1 global stack — create the ACM ' +
          'certificate once (console, or a one-off standalone GlobalStack deploy) ' +
          'and paste its ARN into the site entry (ADR-041)'
      )
    }
    if (resolveEnableWaf(site) && !site.webAclArn) {
      throw new Error(
        `Site "${site.name}" resolves to enableWaf but has no webAclArn. Create ` +
          'the us-east-1 WebACL once and paste its ARN (it may be shared across ' +
          'sites), or set enableWaf: false (ADR-041)'
      )
    }
    if (site.overrides?.backup && 'awsBackup' in site.overrides.backup) {
      throw new Error(
        `Site "${site.name}" must not override backup.awsBackup — the shared DB ` +
          'cluster would be snapshotted once per site (ADR-041)'
      )
    }
  }

  // Connection budget (ADR-041): pg pools open lazily up to their max, so the
  // shared cluster must be sized for the AUTOSCALED worst case, not the steady
  // state. 30% headroom covers rolling deploys (old+new tasks overlap),
  // startup migrations, the site-DB bootstrap Lambda, and superuser reserves.
  const db = { ...envComputed.db, engine: env.dbEngine ?? envComputed.db.engine }
  const maxConnections = estimateMaxConnections(db)
  const worstCase = sites.reduce((sum, site) => {
    const c = deepMerge(envComputed, site.overrides ?? {})
    return sum + c.dbPool.webMax * c.web.maxSize + c.dbPool.workerMax * c.worker.maxTasks
  }, 0)
  const remedy =
    'lower sites[].overrides.dbPool / web.maxSize, raise db.maxAcu, or consider RDS Proxy (ADR-041)'
  if (worstCase > maxConnections) {
    throw new Error(
      `Worst-case DB connections across sites (${worstCase}) exceed the estimated ` +
        `max_connections (${maxConnections}) of the shared database — ${remedy}`
    )
  }
  if (worstCase > maxConnections * 0.7) {
    return (
      `Worst-case DB connections across sites (${worstCase}) exceed 70% of the ` +
      `estimated max_connections (${maxConnections}) of the shared database — ${remedy}`
    )
  }
  return undefined
}

/**
 * Estimated PostgreSQL max_connections of the shared database.
 * Aurora fixes it by maxACU (1 ACU = 2 GiB) regardless of the current ACU:
 * LEAST(memory / 9531392, 5000). The rds engine preset is db.t4g.micro (1 GiB).
 */
function estimateMaxConnections(db: ScaleComputed['db']): number {
  const maxAcu = db.maxAcu ?? 2 // loadConfig default when forcing aurora
  const memoryBytes = (db.engine === 'aurora' ? maxAcu * 2 : 1) * 1024 ** 3
  return Math.min(Math.floor(memoryBytes / 9_531_392), 5000)
}

/**
 * Resolve one site's effective configuration: the site entry merged over its
 * environment, run through the normal loadConfig (reusing all its validation).
 */
export function resolveSiteConfig(
  scope: Construct,
  env: EnvironmentConfig,
  site: SiteConfig
): KukanConfig {
  const merged: EnvironmentConfig = {
    ...env,
    sites: undefined,
    domainName: site.domainName,
    hostedZoneId: site.hostedZoneId,
    hostedZoneName: site.hostedZoneName,
    certificateArn: site.certificateArn,
    webAclArn: site.webAclArn,
    enableWaf: site.enableWaf,
    allowedIpRanges: site.allowedIpRanges,
    basicAuth: site.basicAuth,
    bucketName: site.bucketName,
    enableGa4DataApi: site.enableGa4DataApi,
    overrides: deepMerge(env.overrides ?? {}, site.overrides ?? {}),
  }
  return loadConfig(scope, merged)
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
export function resolveEnableWaf(
  env: Pick<EnvironmentConfig, 'enableWaf' | 'allowedIpRanges' | 'basicAuth'>
): boolean {
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
  /** undefined → AI disabled. `embeddingModel` / `completionModels` are resolved
   *  (never undefined here). */
  bedrock?: BedrockConfig & { embeddingModel: string; completionModels: string[] }
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
    backup: {
      s3Versioning: false,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 7,
      awsBackup: false,
    },
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
    backup: {
      s3Versioning: true,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 14,
      awsBackup: false,
    },
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
    backup: {
      s3Versioning: true,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 35,
      awsBackup: { dailyRetentionDays: 35, monthlyRetentionMonths: 12 },
    },
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
  // env-only (no ctx): structured value, awkward to pass via -c. Default ON —
  // hybrid search is the flagship behaviour and Titan v2 costs are usage-based.
  const bedrockEnv = env.bedrock ?? {}
  const bedrock =
    bedrockEnv === false
      ? undefined
      : {
          ...bedrockEnv,
          embeddingModel: bedrockEnv.embeddingModel ?? DEFAULT_BEDROCK_EMBEDDING_MODEL,
          completionModels: resolveCompletionModels(bedrockEnv.completionModels),
        }

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
  const { backup } = computed
  if (backup.dbBackupRetentionDays < 1 || backup.dbBackupRetentionDays > 35) {
    throw new Error(
      `backup.dbBackupRetentionDays (${backup.dbBackupRetentionDays}) must be 1–35 (RDS/Aurora limit)`
    )
  }
  // AWS Backup for S3 depends on bucket versioning — reject instead of silently forcing it on.
  if (backup.awsBackup && !backup.s3Versioning) {
    throw new Error('backup.awsBackup requires backup.s3Versioning: true (ADR-037)')
  }
  if (backup.awsBackup && backup.awsBackup.dailyRetentionDays < 1) {
    throw new Error('backup.awsBackup.dailyRetentionDays must be >= 1')
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
    bedrock,
    ...computed,
    db,
  }
}
