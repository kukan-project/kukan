/**
 * KUKAN CDK Configuration
 * Scale-based defaults for small / medium / large deployments,
 * resolved against a per-environment definition (see config/environments.ts, ADR-031).
 */

import type { Construct } from 'constructs'
// Resolves to dist/ — the cdk.json app command builds @kukan/shared first so
// synth works on a clean checkout (the pipeline runs no workspace build)
import { DEFAULT_BEDROCK_COMPLETION_MODEL } from '@kukan/shared/ai'
import { isTimeZone } from '@kukan/shared/env'

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
  // --- Site-scoped fields, enableWaf through timeZone (ADR-041) ---
  // Legacy single-site placement, kept for compatibility: without `sites` they
  // apply to the environment's one site; with `sites` declared they are
  // rejected at synth (validateSites) — declare them per site instead.
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
  /** IANA zone the web prerenders times in (env `TIME_ZONE`). Omit → Asia/Tokyo. */
  timeZone?: string
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
   * Sites deployed at once after the canary (ADR-041 wave parallelism). The
   * first site always deploys alone; the rest go this many at a time, each
   * wave waiting for the previous one. The connection budget counts this many
   * sites' rolling-update overlap (minSize new tasks each), so a value that
   * does not fit fails synth (size the database up first — see the table in
   * docs/specs phase4-deploy).
   * Omit → 2; set 1 to serialize. Multi-site only.
   */
  deployConcurrency?: number
  /**
   * Images kept in the CDK bootstrap container-assets repository (newest
   * first); older ones expire. Environments in one account/region share the
   * repository, so give them the same value. Omit → 100.
   */
  ecrImageRetention?: number
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
   * Web image brand (ADR-042): the Docker build arg `KUKAN_BRAND`. Default
   * `'default'` (the `apps/web/brands/default` brand) — omitting it or setting
   * `'default'` are equivalent. Any other value requires a matching
   * `apps/web/brands/<brand>/` (an unknown brand fails the image build).
   */
  brand?: string
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  timeZone?: string
  /**
   * Pre-created us-east-1 ACM certificate ARN. Omit in standalone mode to have
   * the environment's KukanGlobalStack create one per site domain; pipeline
   * mode requires the ARN (cross-region references are incompatible with CDK
   * Pipelines — same rule as single-site, ADR-030).
   */
  certificateArn?: string
  /** Pre-created us-east-1 WAF WebACL ARN. May be shared by several sites.
   *  Omit in standalone mode to have KukanGlobalStack create one shared ACL. */
  webAclArn?: string
  enableWaf?: boolean
  allowedIpRanges?: string[]
  basicAuth?: { username: string; password: string }
  /** S3 bucket name. Omit → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi?: boolean
  /**
   * Listener rule priority on the environment's shared ALB (ADR-049). Omit →
   * derived from the site name (a stable hash in 1000–49999), so removing or
   * reordering sites never renumbers the others. Set it (1–999 — the derived
   * band is reserved, so an explicit value can never collide with one) on the
   * site you are adding when validateSites reports a collision, or to pin an
   * order deliberately. Never move a deployed site's value onto another
   * deployed site's: the live rule still holds it and the deploy fails.
   */
  albPriority?: number
  /**
   * Per-site sizing on top of the environment's scale preset. Only the
   * site-owned sections — db/opensearch sizing belongs to the shared boxes.
   * Of `backup`, only the S3 (site bucket) settings are allowed: DB retention
   * and the AWS Backup schedule are environment-level settings (the DB plan
   * lives in the SharedStack, the per-site bucket plans follow the same
   * schedule — ADR-041).
   */
  overrides?: DeepPartial<Pick<ScaleComputed, 'web' | 'worker' | 'dbPool'>> & {
    backup?: Partial<
      Pick<ScaleComputed['backup'], 's3Versioning' | 's3NoncurrentVersionExpirationDays'>
    >
  }
}

const SITE_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}$/

/** Runtime mirrors of the SiteConfig.overrides type (see validateSites). The
 *  `satisfies` binds them to the type — extending it fails to compile until
 *  the list here is updated, same pattern as SITE_SCOPED_FIELDS below. */
const SITE_OVERRIDE_SECTIONS = Object.keys({
  web: true,
  worker: true,
  dbPool: true,
  backup: true,
} satisfies Record<keyof NonNullable<SiteConfig['overrides']>, true>)
const SITE_BACKUP_KEYS = Object.keys({
  s3Versioning: true,
  s3NoncurrentVersionExpirationDays: true,
} satisfies Record<keyof NonNullable<NonNullable<SiteConfig['overrides']>['backup']>, true>)

/**
 * SiteConfig fields that shadow an EnvironmentConfig field. Single source for
 * validateSites (reject them on the env entry — an env-level value would be
 * silently discarded, worst for the security gates allowedIpRanges/basicAuth)
 * and resolveSiteConfig (copy them from the site). The `satisfies` makes a new
 * site-scoped field fail to compile until both consumers pick it up.
 * `name`/`brand`/`albPriority` have no env-level counterpart; `overrides`
 * deliberately deep-merges instead (shared tuning + per-site tweaks).
 */
type SiteScopedKey = Exclude<keyof SiteConfig, 'name' | 'brand' | 'albPriority' | 'overrides'>
const SITE_SCOPED_FIELDS = Object.keys({
  domainName: true,
  hostedZoneId: true,
  hostedZoneName: true,
  certificateArn: true,
  webAclArn: true,
  enableWaf: true,
  allowedIpRanges: true,
  basicAuth: true,
  bucketName: true,
  enableGa4DataApi: true,
  timeZone: true,
} satisfies Record<SiteScopedKey, true>) as SiteScopedKey[]

/** Sites deployed at once after the canary when `deployConcurrency` is omitted.
 *  Two costs only minSize new tasks' connections per extra site (see the budget). */
export const DEFAULT_DEPLOY_CONCURRENCY = 2

/** Images kept in the container-assets repository when `ecrImageRetention` is omitted:
 *  roughly two months of daily deploys, and far beyond what running tasks reference. */
export const DEFAULT_ECR_IMAGE_RETENTION = 100

function positiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer of 1 or more (got ${String(value)})`)
  }
  return value
}

/** Validated `ecrImageRetention` (images kept, ≥ 1). */
export function resolveEcrImageRetention(
  env: Pick<EnvironmentConfig, 'ecrImageRetention'>
): number {
  return positiveInt('ecrImageRetention', env.ecrImageRetention ?? DEFAULT_ECR_IMAGE_RETENTION)
}

/**
 * Environments in one account/region share the bootstrap repository, so their
 * `ecrImageRetention` must agree — otherwise the last deploy silently wins.
 */
export function validateEcrImageRetention(environments: Record<string, EnvironmentConfig>): void {
  const seen = new Map<string, { name: string; keep: number }>()
  for (const [name, env] of Object.entries(environments)) {
    const { account, region } = resolveEnv(env)
    const key = `${account}/${region}`
    const keep = resolveEcrImageRetention(env)
    const prior = seen.get(key)
    if (prior && prior.keep !== keep) {
      throw new Error(
        `ecrImageRetention differs between "${prior.name}" (${prior.keep}) and "${name}" (${keep}), ` +
          `which share the bootstrap ECR repository in ${key}`
      )
    }
    seen.set(key, { name, keep })
  }
}

/** Validated `deployConcurrency` (sites per wave after the canary, ≥ 1). */
export function resolveDeployConcurrency(
  env: Pick<EnvironmentConfig, 'deployConcurrency'>
): number {
  return positiveInt('deployConcurrency', env.deployConcurrency ?? DEFAULT_DEPLOY_CONCURRENCY)
}

/** RDS instance class shape, `db.<family>.<size>` — the DatabaseConstruct strips
 *  the prefix and hands the rest to EC2 InstanceType, so anything else would
 *  synthesize into a CloudFormation error at deploy time. */
const RDS_INSTANCE_CLASS_PATTERN = /^db\.[a-z0-9]+\.[a-z0-9]+$/

/** The rds engine's class when a preset (medium/large default to Aurora) or the
 *  operator names none. */
export const RDS_DEFAULT_INSTANCE_CLASS = 'db.t4g.micro'

/** RDS memory decomposes as size × family: sizes are GiB for the t/m families
 *  (large = 8); r doubles that, and the x generations differ from each other
 *  (x2g.large 32 GiB, x2iedn.xlarge 128 GiB), so they are listed by name. */
const RDS_SIZE_GIB: Record<string, number> = {
  micro: 1,
  small: 2,
  medium: 4,
  large: 8,
  xlarge: 16,
  '2xlarge': 32,
  '4xlarge': 64,
  '8xlarge': 128,
  '12xlarge': 192,
  '16xlarge': 256,
  '24xlarge': 384,
}
const RDS_FAMILY_MEMORY_FACTOR: Record<string, number> = {
  t: 1,
  m: 1,
  r: 2,
  x2g: 4,
  x2idn: 4,
  x2iedn: 8,
  x2iezn: 8,
}

/** The rds instance class — computeScaled guarantees it for the rds engine. */
export function rdsInstanceClass(db: ScaleComputed['db']): string {
  if (!db.instanceClass) {
    throw new Error(
      'db.instanceClass is unset for the rds engine (computeScaled should have filled it)'
    )
  }
  return db.instanceClass
}

/** Memory of an RDS class in GiB, or a synth error for a shape the connection
 *  budget cannot size — better than quietly budgeting it as a micro. */
function rdsInstanceMemoryGib(instanceClass: string): number {
  const [, family = '', size = ''] = instanceClass.split('.')
  const gib = RDS_SIZE_GIB[size]
  // t/m/r keep their ratio across generations (t4g, m6g, r7g…); x is per name
  const factor = RDS_FAMILY_MEMORY_FACTOR[family] ?? RDS_FAMILY_MEMORY_FACTOR[family.charAt(0)]
  if (
    gib === undefined ||
    factor === undefined ||
    (family.startsWith('x') && !(family in RDS_FAMILY_MEMORY_FACTOR))
  ) {
    throw new Error(
      `db.instanceClass "${instanceClass}" is not a known RDS class shape (families t*/m*/r*/` +
        `${Object.keys(RDS_FAMILY_MEMORY_FACTOR)
          .filter((f) => f.length > 1)
          .join('/')}, ` +
        `sizes ${Object.keys(RDS_SIZE_GIB).join('/')}) — the connection budget cannot size it`
    )
  }
  return gib * factor
}

/**
 * Deploy order of a multi-site environment (ADR-041): the first site alone as
 * the canary, then `concurrency` sites per wave. The stage wires each wave
 * onto the previous one, and the connection budget counts the largest wave —
 * one function so the two can never disagree.
 */
export function deployWaves<T>(sites: readonly T[], concurrency: number): T[][] {
  const waves: T[][] = sites.length > 0 ? [[sites[0]]] : []
  for (let i = 1; i < sites.length; i += concurrency) {
    waves.push(sites.slice(i, i + concurrency))
  }
  return waves
}

/** CloudFront's "distributions associated with the same VPC origin" quota — no
 *  increase offered. Every site's distribution uses the environment's single
 *  shared VPC origin (ADR-049), so it caps the sites per environment. */
export const MAX_SITES_PER_ENVIRONMENT = 50

/** Range of site-name-derived listener rule priorities (ADR-049). Explicit
 *  `albPriority` values are confined below the floor, so the two can never collide. */
export const DERIVED_ALB_PRIORITY_MIN = 1000
export const DERIVED_ALB_PRIORITY_MAX = 49999

/**
 * Effective listener rule priority of a site on the shared ALB (ADR-049):
 * the explicit `albPriority`, else a stable FNV-1a hash of the site name
 * folded into the derived range. Deliberately not the `sites[]` index — that
 * would renumber the remaining sites when one is removed, and two stacks
 * could then hold the same priority mid-way through the serial deploy.
 */
export function resolveAlbPriority(site: Pick<SiteConfig, 'name' | 'albPriority'>): number {
  if (site.albPriority !== undefined) return site.albPriority
  let hash = 0x811c9dc5
  for (const ch of site.name) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const span = DERIVED_ALB_PRIORITY_MAX - DERIVED_ALB_PRIORITY_MIN + 1
  return DERIVED_ALB_PRIORITY_MIN + (hash % span)
}

/** One synth-time warning from validateSites, keyed for cdk.Annotations. */
export interface SiteWarning {
  key: string
  message: string
}

/**
 * Validate the `sites` list of a multi-site environment. Throws at synth with
 * an actionable message — misconfiguration must never reach CloudFormation.
 * Returns warning messages (for cdk.Annotations) for conditions that deploy
 * but deserve operator attention (connection budget over 70%, burstable
 * shared OpenSearch).
 * Pass the stage as `scope` so CLI context (-c scale / -c dbEngine) enters the
 * budget the same way it enters loadConfig — the check must see the numbers
 * that actually deploy.
 */
export function validateSites(env: EnvironmentConfig, scope?: Construct): SiteWarning[] {
  const sites = env.sites
  if (sites === undefined) {
    if (env.deployConcurrency !== undefined) {
      throw new Error('deployConcurrency applies to multi-site environments only (declare sites)')
    }
    return []
  }
  const concurrency = resolveDeployConcurrency(env)
  // An empty array would silently fall back to the single-site shape, and
  // adding the first site later would then be a full replacement — reject it.
  if (sites.length === 0) {
    throw new Error(
      'sites is declared but empty — declare at least one site (the multi-site ' +
        'shape), or remove `sites` entirely for the legacy single-site shape (ADR-041)'
    )
  }
  if (sites.length > MAX_SITES_PER_ENVIRONMENT) {
    throw new Error(
      `${sites.length} sites exceed the ${MAX_SITES_PER_ENVIRONMENT} distributions CloudFront ` +
        "allows on one VPC origin (not adjustable) — every site shares the environment's VPC " +
        'origin (ADR-049). Split the sites across more than one environment'
    )
  }
  const siteScopedEnvFields = SITE_SCOPED_FIELDS.filter((key) => env[key] !== undefined)
  if (siteScopedEnvFields.length > 0) {
    throw new Error(
      `Multi-site environments declare ${siteScopedEnvFields.join('/')} per site — ` +
        'move them from the environment entry into sites[]. To share a value ' +
        'across sites, define it once in environments.ts and spread it into ' +
        'each site entry'
    )
  }
  const ctx = <T>(key: string): T | undefined => scope?.node.tryGetContext(key) as T | undefined
  const envComputed = computeScaled(
    ctx<Scale>('scale') ?? env.scale ?? 'small',
    ctx<DbEngine>('dbEngine') ?? env.dbEngine,
    env.overrides
  )
  const warnings: SiteWarning[] = []
  const seen = new Set<string>()
  const priorities = new Map<number, string>()
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
    if (
      site.albPriority !== undefined &&
      (!Number.isInteger(site.albPriority) ||
        site.albPriority < 1 ||
        site.albPriority >= DERIVED_ALB_PRIORITY_MIN)
    ) {
      throw new Error(
        `Site "${site.name}" albPriority must be an integer in 1–${DERIVED_ALB_PRIORITY_MIN - 1} ` +
          `(${DERIVED_ALB_PRIORITY_MIN}–${DERIVED_ALB_PRIORITY_MAX} is reserved for ` +
          'name-derived priorities, ADR-049)'
      )
    }
    const priority = resolveAlbPriority(site)
    const holder = priorities.get(priority)
    if (holder !== undefined) {
      throw new Error(
        `Sites "${holder}" and "${site.name}" resolve to the same shared-ALB listener ` +
          `rule priority ${priority} — set albPriority (1–${DERIVED_ALB_PRIORITY_MIN - 1}) ` +
          'on the site you are adding (changing a deployed site renumbers its live rule, ADR-049)'
      )
    }
    priorities.set(priority, site.name)
    rejectBlankEdgeArns(site, `Site "${site.name}"`)
    // Missing cert/WAF ARNs auto-create in the us-east-1 global stack, but a
    // DNS-validated cert needs the hosted zone — reject that gap here.
    if (site.domainName && !site.certificateArn && !(site.hostedZoneId && site.hostedZoneName)) {
      throw new Error(
        `Site "${site.name}" sets domainName but neither certificateArn nor ` +
          'hostedZoneId/hostedZoneName. Supply the hosted zone so the global ' +
          'stack can create a DNS-validated certificate, or paste a pre-created ' +
          'us-east-1 certificate ARN (ADR-041)'
      )
    }
    // Runtime mirror of the SiteConfig.overrides type (tsx strips types without
    // checking, so hand-written environments.ts needs the real gate). Allow-list
    // instead of deny-list: a disallowed section would be silently ignored by
    // the shared boxes yet still skew the connection budget below.
    if (site.overrides) {
      const badSections = Object.keys(site.overrides).filter(
        (key) => !SITE_OVERRIDE_SECTIONS.includes(key)
      )
      if (badSections.length > 0) {
        throw new Error(
          `Site "${site.name}" must not override ${badSections.join('/')} — only ` +
            `${SITE_OVERRIDE_SECTIONS.join('/')} are per-site; db/opensearch sizing ` +
            'belongs to the shared boxes (set it on the environment entry, ADR-041)'
        )
      }
      const badBackupKeys = Object.keys(site.overrides.backup ?? {}).filter(
        (key) => !SITE_BACKUP_KEYS.includes(key)
      )
      if (badBackupKeys.length > 0) {
        throw new Error(
          `Site "${site.name}" must not override backup.${badBackupKeys.join('/backup.')} — ` +
            `only ${SITE_BACKUP_KEYS.join('/')} are per-site; the backup schedule and ` +
            'DB retention are environment-level settings (ADR-041)'
        )
      }
    }
  }

  // Burstable shared OpenSearch: one site's reindex degrades every site, so
  // warn (not error) from the second site on.
  const enableOpenSearch = ctx<boolean>('enableOpenSearch') ?? env.enableOpenSearch ?? true
  if (
    sites.length >= 2 &&
    enableOpenSearch &&
    envComputed.opensearch.instanceType.startsWith('t3.')
  ) {
    warnings.push({
      key: 'kukan:site-opensearch-small',
      message:
        `Sites share one OpenSearch domain and the resolved instance type is ` +
        `burstable (${envComputed.opensearch.instanceType}) — one site's reindex ` +
        'degrades all sites and t3.small risks heap exhaustion. Use scale ' +
        'medium+ or overrides: { opensearch: { instanceType: … } } (ADR-041)',
    })
  }

  // Connection budget (ADR-041): pg pools open lazily up to their max, so the
  // shared cluster must be sized for the AUTOSCALED worst case, not the steady
  // state. Site stacks deploy `concurrency` at a time (kukan-stage waves), and a
  // rolling update runs old and new tasks together (ECS MaximumPercent 200):
  // the old tasks — up to maxSize, holding their pools while they drain — are
  // already in `steady`, and the template pins DesiredCount to minSize (the
  // service constructs), so a deploy starts only minSize new tasks per site.
  // Count that many for the `concurrency` most expensive sites. Dropping the
  // DesiredCount pin would invalidate this term (it would be maxSize again).
  // 30% headroom covers startup migrations, the site-DB bootstrap Lambda, and
  // superuser reserves.
  const { connections: maxConnections, uncappedConnections } = estimateMaxConnections(
    envComputed.db
  )
  const siteComputed = sites.map((site) => deepMerge(envComputed, site.overrides ?? {}))
  const steady = siteComputed.reduce(
    (sum, c) => sum + c.dbPool.webMax * c.web.maxSize + c.dbPool.workerMax * c.worker.maxTasks,
    0
  )
  // As many sites as the largest wave can roll at once (the canary is a wave of one)
  const rollingSites = Math.max(...deployWaves(sites, concurrency).map((wave) => wave.length))
  const rolling = siteComputed
    .map((c) => c.dbPool.webMax * c.web.minSize + c.dbPool.workerMax * c.worker.minTasks)
    .sort((a, b) => b - a)
    .slice(0, rollingSites)
    .reduce((sum, value) => sum + value, 0)
  const worstCase = steady + rolling
  const breakdown =
    `${worstCase} — steady ${steady} + ${rollingSites} ` +
    `site${rollingSites === 1 ? "'s" : "s'"} rolling update ${rolling}`
  // The remedy must never invite a harmful or ineffective change: an in-place
  // dbEngine switch creates an EMPTY Aurora cluster (different logical ID — no
  // data migration), and any ACU change only takes effect after a reboot
  // (max_connections is static). Which ACU knob to raise is decided against
  // the REQUIRED connections: worstCase > 2,000 with a 0/0.5 minACU needs
  // minAcu (the cap ignores maxAcu), worstCase above the uncapped estimate
  // needs maxAcu, and both can be true at once.
  const lowerPools =
    (concurrency > 1 ? `set deployConcurrency: 1 (${concurrency} sites roll at once now), ` : '') +
    'lower sites[].overrides.dbPool / web.maxSize'
  const separateDeploy =
    'in a SEPARATE deploy first (then reboot the DB instances — max_connections ' +
    'is static and keeps the old value until reboot) before adding sites'
  // `required` is what the limit must reach for the advice to actually work:
  // worstCase for the hard error, ceil(worstCase / 0.7) to clear the warning —
  // an ACU knob that cannot reach it must not be suggested.
  const buildRemedy = (required: number): string => {
    if (envComputed.db.engine !== 'aurora') {
      return (
        `${lowerPools}, or migrate to aurora blue/green with pg_dump/restore — ` +
        'switching dbEngine in place would create an EMPTY Aurora cluster and ' +
        `point the app at it (${rdsInstanceClass(envComputed.db)} allows ` +
        `only ~${maxConnections} connections; a larger instance class raises it) — ` +
        'or consider RDS Proxy (ADR-041)'
      )
    }
    const absoluteMax = AURORA_MAX_CONNECTIONS[AURORA_MAX_CONNECTIONS.length - 1][1]
    if (required > absoluteMax) {
      return (
        `${lowerPools}, split the sites across more than one shared cluster/` +
        `environment, or consider RDS Proxy — no ACU setting reaches the required ` +
        `${required} connections, Aurora PostgreSQL tops out at ${absoluteMax} (ADR-041)`
      )
    }
    const minAcuNote =
      'db.minAcu to 1 or higher (a minimum of 0/0.5 ACUs caps ' +
      'max_connections at 2,000 regardless of maxAcu)'
    const needMinAcu = (envComputed.db.minAcu ?? 0) <= 0.5 && required > 2000
    const needMaxAcu = required > uncappedConnections
    const acuAdvice =
      needMinAcu && needMaxAcu
        ? `raise ${minAcuNote} AND db.maxAcu (the current maxAcu tops out at ` +
          `${uncappedConnections} connections)`
        : needMinAcu
          ? `raise ${minAcuNote}`
          : 'raise db.maxAcu'
    return `${lowerPools}, or ${acuAdvice} ${separateDeploy}, or consider RDS Proxy (ADR-041)`
  }
  if (worstCase > maxConnections) {
    throw new Error(
      `Worst-case DB connections across sites (${breakdown}) exceed the estimated ` +
        `max_connections (${maxConnections}) of the shared database — ${buildRemedy(worstCase)}`
    )
  }
  if (worstCase > maxConnections * 0.7) {
    warnings.push({
      key: 'kukan:site-connection-budget',
      message:
        `Worst-case DB connections across sites (${breakdown}) exceed 70% of the ` +
        `estimated max_connections (${maxConnections}) of the shared database — ` +
        buildRemedy(Math.ceil(worstCase / 0.7)),
    })
  }
  return warnings
}

/**
 * AWS-documented default max_connections for Aurora PostgreSQL Serverless v2
 * by maximum ACU ("Maximum connections for Aurora serverless" table). Held
 * constant regardless of the current ACU. The raw LEAST(memory/9531392, 5000)
 * formula overestimates (it ignores the instance memory overhead), so the
 * budget interpolates between these anchors instead.
 */
const AURORA_MAX_CONNECTIONS: ReadonlyArray<readonly [maxAcu: number, connections: number]> = [
  [1, 189],
  [4, 823],
  [8, 1669],
  [16, 3360],
  [32, 5000],
]

/** Estimated max_connections of the shared database (see AURORA_MAX_CONNECTIONS).
 *  The rds engine preset is db.t4g.micro (1 GiB → ~112 by the raw formula).
 *  `uncappedConnections` is the value before the PostgreSQL rule that a
 *  minimum capacity of 0 or 0.5 ACUs caps max_connections at 2,000 — the
 *  remedy compares the required connections against both bounds to tell
 *  which ACU knob (minAcu, maxAcu, or both) actually helps. */
function estimateMaxConnections(db: ScaleComputed['db']): {
  connections: number
  uncappedConnections: number
} {
  if (db.engine !== 'aurora') {
    // RDS PostgreSQL default: LEAST({DBInstanceClassMemory/9531392}, 5000)
    const gib = rdsInstanceMemoryGib(rdsInstanceClass(db))
    const connections = Math.min(Math.floor((gib * 1024 ** 3) / 9_531_392), 5000)
    return { connections, uncappedConnections: connections }
  }
  const maxAcu = db.maxAcu ?? 2
  const [firstAcu, firstConns] = AURORA_MAX_CONNECTIONS[0]
  const [lastAcu, lastConns] = AURORA_MAX_CONNECTIONS[AURORA_MAX_CONNECTIONS.length - 1]
  let connections: number
  if (maxAcu <= firstAcu) {
    connections = Math.floor((firstConns * maxAcu) / firstAcu)
  } else if (maxAcu >= lastAcu) {
    connections = lastConns
  } else {
    const upper = AURORA_MAX_CONNECTIONS.findIndex(([acu]) => acu >= maxAcu)
    const [a0, c0] = AURORA_MAX_CONNECTIONS[upper - 1]
    const [a1, c1] = AURORA_MAX_CONNECTIONS[upper]
    connections = Math.floor(c0 + ((c1 - c0) * (maxAcu - a0)) / (a1 - a0))
  }
  const capped = (db.minAcu ?? 0) <= 0.5 && connections > 2000
  return { connections: capped ? 2000 : connections, uncappedConnections: connections }
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
    ...(Object.fromEntries(SITE_SCOPED_FIELDS.map((key) => [key, site[key]])) as Pick<
      SiteConfig,
      SiteScopedKey
    >),
    overrides: deepMerge(env.overrides ?? {}, site.overrides ?? {}),
  }
  return loadConfig(scope, merged, SITE_SCOPED_FIELDS)
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

/**
 * The pipeline always lands in the active credentials' account; `pipelineAccount` only
 * refuses a mismatch (misdeployment guard for separate-account operation, ADR-031).
 */
export function assertPipelineAccount(
  pipelineAccount: string | undefined,
  credentialsAccount: string
): void {
  if (pipelineAccount && pipelineAccount !== credentialsAccount) {
    throw new Error(
      `Pipeline account mismatch: config/environments.ts declares pipelineAccount ` +
        `"${pipelineAccount}" but the active credentials are for "${credentialsAccount}". ` +
        `Switch credentials, or update pipelineAccount.`
    )
  }
}

/** WAF default: ON unless an IP allowlist or Basic auth edge gate is set (ADR-027). */
export function resolveEnableWaf(
  env: Pick<EnvironmentConfig, 'enableWaf' | 'allowedIpRanges' | 'basicAuth'>
): boolean {
  return env.enableWaf ?? !(env.allowedIpRanges || env.basicAuth)
}

/**
 * Reject blank/whitespace cert/WAF ARNs at synth. A blank string counts as
 * "missing" in needsGlobalStack (truthiness) yet "supplied" when wiring
 * (`??`), which would create a cert/WAF that never gets attached.
 */
export function rejectBlankEdgeArns(
  entry: Pick<SiteConfig, 'certificateArn' | 'webAclArn'>,
  label: string
): void {
  for (const key of ['certificateArn', 'webAclArn'] as const) {
    const value = entry[key]
    if (value !== undefined && value.trim() === '') {
      throw new Error(
        `${label} sets a blank ${key} — omit the field to have the global stack ` +
          'create it (standalone mode), or paste the real us-east-1 ARN'
      )
    }
  }
}

/** The entry (site or single-site env) needs the global stack to CREATE its
 *  ACM certificate — a domain is set but no pre-created ARN is supplied. */
export function needsManagedCert(
  entry: Pick<SiteConfig, 'domainName' | 'certificateArn'>
): boolean {
  return !!entry.domainName && !entry.certificateArn
}

/** The entry needs the global stack to CREATE its WAF WebACL — WAF resolves
 *  to enabled but no pre-created ARN is supplied. The single source for this
 *  predicate: needsGlobalStack (branch), KukanGlobalStack (creation), and
 *  KukanStage (wiring) must never disagree on it. */
export function needsManagedWaf(
  entry: Pick<SiteConfig, 'enableWaf' | 'allowedIpRanges' | 'basicAuth' | 'webAclArn'>
): boolean {
  return resolveEnableWaf(entry) && !entry.webAclArn
}

/**
 * Whether this environment must CREATE the us-east-1 global stack (ACM cert / WAF).
 * False when the ARNs are supplied (pipeline mode passes them as strings — ADR-030).
 * Multi-site: true when any site is missing an ARN it needs (ADR-041).
 */
export function needsGlobalStack(env: EnvironmentConfig): boolean {
  const entries = env.sites?.length ? env.sites : [env]
  return entries.some((entry) => needsManagedCert(entry) || needsManagedWaf(entry))
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
  timeZone?: string
  /** undefined → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi: boolean
  /** undefined → AI disabled. `embeddingModel` / `completionModels` are resolved
   *  (never undefined here). */
  bedrock?: BedrockConfig & { embeddingModel: string; completionModels: string[] }
  /** Images kept in the bootstrap container-assets repository (account/region-wide). */
  ecrImageRetention: number
}

const SCALE_DEFAULTS: Record<Scale, ScaleComputed> = {
  small: {
    web: { cpu: 256, memory: 512, minSize: 1, maxSize: 2 },
    worker: { cpu: 256, memory: 1024, minTasks: 1, maxTasks: 2, healthPort: 8080 },
    db: { engine: 'rds', instanceClass: RDS_DEFAULT_INSTANCE_CLASS, multiAz: false },
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
 * `ignoreContext` lists keys the `-c` channel must NOT override — site stacks
 * pass the site-scoped fields, otherwise one `-c domainName=…` would stamp the
 * same domain/bucket/edge-gate onto every site (ADR-041).
 */
export function loadConfig(
  scope: Construct,
  env: Partial<EnvironmentConfig> = {},
  ignoreContext: readonly string[] = []
): KukanConfig {
  const ctx = <T>(key: string): T | undefined =>
    ignoreContext.includes(key) ? undefined : (scope.node.tryGetContext(key) as T | undefined)

  const scale = ctx<Scale>('scale') ?? env.scale ?? 'small'
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
  // env-only (no ctx): shared by every environment in the account/region and
  // checked for agreement across environments.ts (validateEcrImageRetention).
  const ecrImageRetention = resolveEcrImageRetention(env)
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

  const computed = computeScaled(scale, ctx<DbEngine>('dbEngine') ?? env.dbEngine, env.overrides)
  const { db } = computed

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

  const timeZone = ctx<string>('timeZone') ?? env.timeZone
  // The web validates TIME_ZONE too, but only where it renders: a typo caught
  // here stops the deploy instead of every page after it.
  if (timeZone !== undefined && !isTimeZone(timeZone)) {
    throw new Error(`timeZone "${timeZone}" is not an IANA time zone name (e.g. Asia/Tokyo, UTC)`)
  }

  return {
    scale,
    dbEngine: db.engine,
    enableOpenSearch,
    enableWaf,
    allowedIpRanges,
    basicAuth,
    domainName,
    timeZone,
    hostedZoneId,
    hostedZoneName,
    bucketName,
    enableGa4DataApi,
    bedrock,
    ecrImageRetention,
    ...computed,
  }
}

/**
 * Scale preset + overrides + db engine/ACU resolution — shared by loadConfig
 * and the multi-site connection budget (validateSites) so the two can never
 * disagree on the numbers.
 */
function computeScaled(
  scale: Scale,
  dbEngine: DbEngine | undefined,
  overrides?: DeepPartial<ScaleComputed>
): ScaleComputed {
  const computed = deepMerge<ScaleComputed>(SCALE_DEFAULTS[scale], overrides)
  const db = { ...computed.db, engine: dbEngine ?? computed.db.engine }
  if (db.engine === 'aurora' && db.minAcu == null) {
    db.minAcu = 0
    db.maxAcu = 2
  }
  if (db.engine === 'rds') {
    // The medium/large presets carry no class (they default to Aurora)
    db.instanceClass ??= RDS_DEFAULT_INSTANCE_CLASS
    if (!RDS_INSTANCE_CLASS_PATTERN.test(db.instanceClass)) {
      throw new Error(
        `db.instanceClass "${db.instanceClass}" must look like db.<family>.<size> (e.g. db.t4g.small)`
      )
    }
    rdsInstanceMemoryGib(db.instanceClass) // a shape the connection budget can size
  }
  return { ...computed, db }
}
