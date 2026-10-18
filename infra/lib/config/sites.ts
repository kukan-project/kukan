/**
 * Multi-site environments (ADR-041): site naming, the fields a site may set,
 * ALB rule priorities (ADR-049), deploy waves, and the synth-time validation.
 */

import type { Construct } from 'constructs'
import type {
  DbEngine,
  EnvironmentConfig,
  KukanConfig,
  Scale,
  ScaleComputed,
  SiteConfig,
} from './types.js'
import {
  AURORA_MAX_CONNECTIONS_CEILING,
  computeScaled,
  deepMerge,
  estimateMaxConnections,
  rdsInstanceClass,
} from './scale.js'
import { rejectBlankEdgeArns } from './edge.js'
import { contextFlag, loadConfig, positiveInt } from './load.js'

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
 * `name`/`brand`/`albPriority` have no env-level counterpart; `overrides` and
 * `bedrock` deliberately deep-merge instead (shared setting + per-site tweaks).
 */
type SiteScopedKey = Exclude<
  keyof SiteConfig,
  'name' | 'brand' | 'albPriority' | 'overrides' | 'bedrock'
>

const SITE_SCOPED_FIELDS = Object.keys({
  domainName: true,
  hostedZoneId: true,
  hostedZoneName: true,
  certificateArn: true,
  webAclArn: true,
  enableWaf: true,
  allowedIpRanges: true,
  basicAuth: true,
  enableIpv6Dns: true,
  bucketName: true,
  enableGa4DataApi: true,
  nameSiteInUserAgent: true,
  timeZone: true,
} satisfies Record<SiteScopedKey, true>) as SiteScopedKey[]

/** Sites deployed at once after the canary when `deployConcurrency` is omitted.
 *  Two costs only minSize new tasks' connections per extra site (see the budget). */
export const DEFAULT_DEPLOY_CONCURRENCY = 2

/** Validated `deployConcurrency` (sites per wave after the canary, ≥ 1). */
export function resolveDeployConcurrency(
  env: Pick<EnvironmentConfig, 'deployConcurrency'>
): number {
  return positiveInt('deployConcurrency', env.deployConcurrency ?? DEFAULT_DEPLOY_CONCURRENCY)
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
    // Nothing to override: the environment declares no allow-list, and a
    // per-site one would have to be complete rather than a tweak of it.
    if (env.bedrock === false && site.bedrock !== undefined) {
      throw new Error(
        `Site "${site.name}" sets bedrock but the environment has bedrock: false — ` +
          "per-site AI adjusts the environment's settings, so declare bedrock on the " +
          'environment entry and turn it off per site with bedrock: false (ADR-041)'
      )
    }
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
      // The type leaves it out; this is the gate for what tsx does not check
      const worker = site.overrides.worker as { healthPort?: unknown } | undefined
      if (worker?.healthPort !== undefined) {
        throw new Error(
          `Site "${site.name}" must not override worker.healthPort — the shared ` +
            "security groups open the environment's port to the web (ADR-058)"
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
  const enableOpenSearch =
    contextFlag('enableOpenSearch', ctx<unknown>('enableOpenSearch')) ??
    env.enableOpenSearch ??
    true
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
  const perWeb = (c: ScaleComputed) => c.dbPool.webMax
  const perWorker = (c: ScaleComputed) => c.dbPool.workerMax
  const steady = siteComputed.reduce(
    (sum, c) => sum + perWeb(c) * c.web.maxSize + perWorker(c) * c.worker.maxTasks,
    0
  )
  // As many sites as the largest wave can roll at once (the canary is a wave of one)
  const rollingSites = Math.max(...deployWaves(sites, concurrency).map((wave) => wave.length))
  const rollingCosts = siteComputed
    .map((c) => perWeb(c) * c.web.minSize + perWorker(c) * c.worker.minTasks)
    .sort((a, b) => b - a)
  const rollingFor = (count: number) =>
    rollingCosts.slice(0, count).reduce((sum, value) => sum + value, 0)
  const rolling = rollingFor(rollingSites)
  const worstCase = steady + rolling
  // The most sites that can roll at once and stay within `limit`, which is
  // what deployConcurrency costs: minSize new tasks per site, whatever maxSize.
  // 0 when even one at a time does not fit — no deployConcurrency helps then
  const fittingConcurrency = (limit: number) => {
    let count = 0
    while (count < rollingSites && steady + rollingFor(count + 1) <= limit) count++
    return count
  }
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
  const lowerPools = (limit: number) => {
    const fitting = fittingConcurrency(limit)
    return (
      (fitting > 0 && fitting < rollingSites
        ? `set deployConcurrency: ${fitting} (${rollingSites} sites roll at once now), `
        : '') + 'lower sites[].overrides.dbPool / web.maxSize'
    )
  }
  const separateDeploy =
    'in a SEPARATE deploy first (then reboot the DB instances — max_connections ' +
    'is static and keeps the old value until reboot) before adding sites'
  // `required` is what the limit must reach for the advice to actually work:
  // worstCase for the hard error, ceil(worstCase / 0.7) to clear the warning —
  // an ACU knob that cannot reach it must not be suggested. `limit` is the line
  // the current database draws, which deployConcurrency is lowered to fit.
  const buildRemedy = (required: number, limit: number): string => {
    if (envComputed.db.engine !== 'aurora') {
      return (
        `${lowerPools(limit)}, or migrate to aurora blue/green with pg_dump/restore — ` +
        'switching dbEngine in place would create an EMPTY Aurora cluster and ' +
        `point the app at it (${rdsInstanceClass(envComputed.db)} allows ` +
        `only ~${maxConnections} connections; a larger instance class raises it) — ` +
        'or consider RDS Proxy (ADR-041)'
      )
    }
    const absoluteMax = AURORA_MAX_CONNECTIONS_CEILING
    if (required > absoluteMax) {
      return (
        `${lowerPools(limit)}, split the sites across more than one shared cluster/` +
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
    return `${lowerPools(limit)}, or ${acuAdvice} ${separateDeploy}, or consider RDS Proxy (ADR-041)`
  }
  if (worstCase > maxConnections) {
    throw new Error(
      `Worst-case DB connections across sites (${breakdown}) exceed the estimated ` +
        `max_connections (${maxConnections}) of the shared database — ` +
        buildRemedy(worstCase, maxConnections)
    )
  }
  if (worstCase > maxConnections * 0.7) {
    warnings.push({
      key: 'kukan:site-connection-budget',
      message:
        `Worst-case DB connections across sites (${breakdown}) exceed 70% of the ` +
        `estimated max_connections (${maxConnections}) of the shared database — ` +
        buildRemedy(Math.ceil(worstCase / 0.7), maxConnections * 0.7),
    })
  }
  return warnings
}

/** Per-site Bedrock over the environment's (see SiteConfig.bedrock). */
function resolveSiteBedrock(
  envBedrock: EnvironmentConfig['bedrock'],
  siteBedrock: SiteConfig['bedrock']
): EnvironmentConfig['bedrock'] {
  if (siteBedrock === undefined) return envBedrock
  if (siteBedrock === false) return false
  return deepMerge(envBedrock || {}, siteBedrock)
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
    bedrock: resolveSiteBedrock(env.bedrock, site.bedrock),
    overrides: deepMerge(env.overrides ?? {}, site.overrides ?? {}),
  }
  return loadConfig(scope, merged, SITE_SCOPED_FIELDS)
}
