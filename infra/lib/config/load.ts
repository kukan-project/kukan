/**
 * Resolving an environment entry into the configuration the stacks consume:
 * environment-level defaults and checks, and loadConfig itself.
 */

import type { Construct } from 'constructs'
// Resolves to dist/ — the cdk.json app command builds @kukan/shared first so
// synth works on a clean checkout (the pipeline runs no workspace build)
import { DEFAULT_BEDROCK_COMPLETION_MODEL } from '@kukan/shared/ai'
import { isTimeZone } from '@kukan/shared/env'
import { RDS_CA_CERTIFICATES } from './types.js'
import type {
  BedrockConfig,
  CpuArchitecture,
  DbEngine,
  EnvironmentConfig,
  KukanConfig,
  RdsCaCertificate,
  Scale,
} from './types.js'
import { computeScaled } from './scale.js'
import { isEdgeGated } from './edge.js'

/** Default region when an environment does not specify one. */
export const DEFAULT_REGION = 'ap-northeast-1'

/** Matches the bedrock adapter's default (packages/adapters/ai). Resolved here so
 *  the container env and the IAM model scope always agree. */
export const DEFAULT_BEDROCK_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'

/** Images kept in the container-assets repository when `ecrImageRetention` is omitted:
 *  roughly two months of daily deploys, and far beyond what running tasks reference. */
export const DEFAULT_ECR_IMAGE_RETENTION = 100

/** Architecture of the web and worker when `cpuArchitecture` is omitted. */
export const DEFAULT_CPU_ARCHITECTURE: CpuArchitecture = 'arm64'

/** CA of the database's server certificate when `rdsCaCertificate` is omitted. */
export const DEFAULT_RDS_CA_CERTIFICATE: RdsCaCertificate = 'rds-ca-rsa2048-g1'

/** Days CloudFront access logs are kept when `cdnLogRetentionDays` is omitted:
 *  long enough to look back on a burst noticed weeks later. */
export const DEFAULT_CDN_LOG_RETENTION_DAYS = 90

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

/**
 * Validate `summaryModel` against the allow-list, normalized the same way the
 * adapter normalizes it. Outside the list the worker refuses the model at
 * startup and abstracts stay off (ADR-053) — a deploy that looks successful and
 * writes nothing, so reject it at synth instead. Omit → abstracts off.
 */
function resolveSummaryModel(
  model: string | undefined,
  completionModels: string[]
): string | undefined {
  if (model === undefined) return undefined
  const normalized = model.trim()
  if (!completionModels.includes(normalized)) {
    throw new Error(
      `bedrock.summaryModel "${normalized}" is not in bedrock.completionModels ` +
        `(${completionModels.join(', ')}) — that list is the IAM grant, so the worker ` +
        'would refuse the model and leave abstracts off (ADR-053)'
    )
  }
  return normalized
}

/** Model IDs and similarity floor filled in, `false` resolved to AI disabled. */
function resolveBedrock(bedrock: BedrockConfig | false): KukanConfig['bedrock'] {
  if (bedrock === false) return undefined
  const completionModels = resolveCompletionModels(bedrock.completionModels)
  return {
    ...bedrock,
    embeddingModel: bedrock.embeddingModel ?? DEFAULT_BEDROCK_EMBEDDING_MODEL,
    completionModels,
    summaryModel: resolveSummaryModel(bedrock.summaryModel, completionModels),
  }
}

/** `value` checked to be an integer of 1 or more, named `field` in the error. */
export function positiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer of 1 or more (got ${String(value)})`)
  }
  return value
}

/**
 * A boolean from CDK context: `-c key=false` arrives as the string "false",
 * truthy as it stands, while cdk.json gives a real boolean.
 */
export function contextFlag(key: string, value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`-c ${key} must be true or false (got ${JSON.stringify(value)})`)
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

/**
 * Validated `cpuArchitecture`. Checked at runtime too because tsx strips types
 * without type-checking, and a typo would otherwise fall through to x86_64.
 */
export function resolveCpuArchitecture(
  env: Pick<EnvironmentConfig, 'cpuArchitecture'>
): CpuArchitecture {
  const arch = env.cpuArchitecture ?? DEFAULT_CPU_ARCHITECTURE
  if (arch !== 'x86_64' && arch !== 'arm64') {
    throw new Error(`cpuArchitecture must be "x86_64" or "arm64" (got ${JSON.stringify(arch)})`)
  }
  return arch
}

/** Validated `rdsCaCertificate`, checked at runtime for the same reason. */
export function resolveRdsCaCertificate(
  env: Pick<EnvironmentConfig, 'rdsCaCertificate'>
): RdsCaCertificate {
  const ca = env.rdsCaCertificate ?? DEFAULT_RDS_CA_CERTIFICATE
  if (!RDS_CA_CERTIFICATES.includes(ca)) {
    throw new Error(
      `rdsCaCertificate must be one of ${RDS_CA_CERTIFICATES.join(', ')} (got ${JSON.stringify(ca)})`
    )
  }
  return ca
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
  const flag = (key: string): boolean | undefined => contextFlag(key, ctx<unknown>(key))

  const scale = ctx<Scale>('scale') ?? env.scale ?? 'small'
  const enableOpenSearch = flag('enableOpenSearch') ?? env.enableOpenSearch ?? true
  // env-only (no ctx): the pipeline picks its asset-publishing CodeBuild from
  // the entry, which a -c on a standalone deploy cannot reach
  const cpuArchitecture = resolveCpuArchitecture(env)
  // env-only (no ctx): the database is shared by every site in the environment
  const rdsCaCertificate = resolveRdsCaCertificate(env)
  const allowedIpRanges = ctx<string[]>('allowedIpRanges') ?? env.allowedIpRanges
  // Read as written, an empty allowlist admits nobody; the viewer-request
  // function reads it as no gate at all. Neither can be what was meant.
  if (allowedIpRanges?.length === 0) {
    throw new Error(
      'allowedIpRanges is empty — omit it to leave the site open, or list the ranges to admit'
    )
  }
  // env-only (no ctx): a credential must not live in committed cdk.json / shell history.
  const basicAuth = env.basicAuth
  // WAF provides managed rules on CloudFront scope (ADR-027). The edge gate (IP allowlist
  // and/or Basic auth) is handled by a CloudFront Function, so WAF defaults OFF when either
  // is set (saves ~$9/month).
  const enableWafExplicit = flag('enableWaf') ?? env.enableWaf
  const edgeGated = isEdgeGated({ allowedIpRanges, basicAuth })
  const enableWaf = enableWafExplicit ?? !edgeGated
  // Off behind an IP allowlist unless asked: see EnvironmentConfig.enableIpv6Dns
  const enableIpv6Dns = flag('enableIpv6Dns') ?? env.enableIpv6Dns ?? !allowedIpRanges
  // Asked for, not inferred: whether a site is meant to be found is the
  // operator's call. Behind an edge gate it cannot be, whatever was asked.
  const nameSiteInUserAgent = flag('nameSiteInUserAgent') ?? env.nameSiteInUserAgent ?? false
  if (nameSiteInUserAgent && edgeGated) {
    throw new Error(
      'nameSiteInUserAgent is set on an edge-gated site — the worker would hand out ' +
        'an address the gate keeps from the public; drop one of the two'
    )
  }
  const domainName = ctx<string>('domainName') ?? env.domainName
  const hostedZoneId = ctx<string>('hostedZoneId') ?? env.hostedZoneId
  const hostedZoneName = ctx<string>('hostedZoneName') ?? env.hostedZoneName
  // undefined → CDK auto-naming (globally unique). ADR-031.
  const bucketName = ctx<string>('bucketName') ?? env.bucketName
  const enableGa4DataApi = flag('enableGa4DataApi') ?? env.enableGa4DataApi ?? false
  // env-only (no ctx): shared by every environment in the account/region and
  // checked for agreement across environments.ts (validateEcrImageRetention).
  const ecrImageRetention = resolveEcrImageRetention(env)
  // env-only (no ctx): applies to every site's log bucket
  const cdnLogRetentionDays = positiveInt(
    'cdnLogRetentionDays',
    env.cdnLogRetentionDays ?? DEFAULT_CDN_LOG_RETENTION_DAYS
  )
  // No ctx: the pipeline never sees a -c, so a shell into the tasks stays
  // visible in the committed entry rather than one deploy's flags
  const enableExecuteCommand = env.enableExecuteCommand ?? false
  // env-only (no ctx): structured value, awkward to pass via -c. Default ON —
  // hybrid search is the flagship behaviour and Titan v2 costs are usage-based.
  const bedrock = resolveBedrock(env.bedrock ?? {})

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
    cpuArchitecture,
    rdsCaCertificate,
    enableWaf,
    allowedIpRanges,
    basicAuth,
    enableIpv6Dns,
    nameSiteInUserAgent,
    domainName,
    timeZone,
    hostedZoneId,
    hostedZoneName,
    bucketName,
    enableGa4DataApi,
    bedrock,
    ecrImageRetention,
    cdnLogRetentionDays,
    enableExecuteCommand,
    ...computed,
  }
}
