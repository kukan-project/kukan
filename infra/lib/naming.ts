/**
 * KUKAN resource naming helper (ADR-031).
 *
 * Derives a per-environment prefix from the enclosing CDK Stage so that
 * explicitly-named resources stay human-readable in the console AND unique
 * across environments in the same account (e.g. `kukan-dev`, `kukan-prd`).
 *
 * Stage-aware: works for both the pipeline (stages added to the pipeline) and
 * standalone (`new KukanStage(app, 'Dev', ...)`) modes. Falls back to `kukan`
 * when no enclosing Stage exists.
 */

import * as cdk from 'aws-cdk-lib'
import type { Construct } from 'constructs'

/**
 * Marker for stacks that scope naming to one site (ADR-041). KukanSiteStack
 * assigns `kukanSiteName` before creating children, which extends every name
 * derived here to `kukan-<env>-<site>-*` without touching the constructs.
 * A stack property rather than CDK context: context resolves up to the App,
 * so a stray `-c kukan:site=x` or cdk.json entry could silently rename every
 * environment's resources — a property is settable by code only.
 */
export interface SiteScopedStack {
  readonly kukanSiteName: string
}

/** Per-environment prefix, e.g. `kukan-dev` (with a site: `kukan-dev-<site>`). */
export function envPrefix(scope: Construct): string {
  const stack = scope.node.scopes.filter(cdk.Stack.isStack).pop() as
    (cdk.Stack & Partial<SiteScopedStack>) | undefined
  return sitePrefix(scope, stack?.kukanSiteName)
}

/** The environment's name, e.g. `dev`: its Stage's, lowercased. */
export function envName(scope: Construct): string | undefined {
  // Stage.of a Stage is the one around it
  const stage = cdk.Stage.isStage(scope) ? scope : cdk.Stage.of(scope)
  return stage?.stageName.toLowerCase()
}

/**
 * A site's prefix named from outside its stack, as the SharedStack names each
 * site's task roles (ADR-069). envPrefix inside that SiteStack is this string.
 */
export function sitePrefix(scope: Construct, siteName: string | undefined): string {
  const env = envName(scope)
  const base = env ? `kukan-${env}` : 'kukan'
  return siteName ? `${base}-${siteName}` : base
}

/** IAM's limit on a role name. */
const MAX_ROLE_NAME_LENGTH = 64

/**
 * The fixed name of a site's web or worker task role, e.g.
 * `kukan-dev-citya-web-task`. Fixed so the SharedStack can map it in
 * OpenSearch from the site list alone, before the role exists (ADR-069).
 */
export function taskRoleName(prefix: string, service: 'web' | 'worker'): string {
  const name = `${prefix}-${service}-task`
  if (name.length > MAX_ROLE_NAME_LENGTH) {
    throw new Error(
      `Task role name "${name}" is longer than IAM allows (${MAX_ROLE_NAME_LENGTH}): ` +
        'shorten the environment or site name'
    )
  }
  return name
}

/** Env-prefixed resource name, e.g. `kukan-dev-web`. */
export function resourceName(scope: Construct, suffix: string): string {
  return `${envPrefix(scope)}-${suffix}`
}

/**
 * The shared-box values KukanSharedStack publishes and KukanSiteStack reads
 * (ADR-041 / ADR-049). One list so a key mismatch between writer and reader
 * fails to compile instead of failing at the site stack's deploy.
 */
export type SharedParam =
  | 'vpc/id'
  | 'vpc/azs'
  | 'vpc/public-subnet-ids'
  | 'vpc/isolated-subnet-ids'
  | 'sg/alb'
  | 'sg/web'
  | 'sg/worker'
  | 'sg/db-access'
  | 'ecs/cluster-name'
  | 'cloudmap/namespace-id'
  | 'cloudmap/namespace-name'
  | 'alb/listener-arn'
  | 'alb/dns-name'
  | 'cloudfront/vpc-origin-id'
  | 'db/endpoint'
  | 'db/port'
  | 'db/master-secret-arn'
  | 'search/endpoint'
  | 'search/arn'

/**
 * SSM parameter name for a shared-box value, e.g. `/kukan/dev/shared/vpc/id`
 * (ADR-041). Derived from the Stage only — deliberately ignores the site
 * context so SiteStacks read the same names SharedStack writes.
 */
export function sharedParamName(scope: Construct, suffix: SharedParam): string {
  return `/kukan/${envName(scope) ?? 'kukan'}/shared/${suffix}`
}

/**
 * The environment's Athena workgroup, e.g. `kukan-dev-logs`. Derived from the
 * Stage only, like sharedParamName: every site of the environment names the same one.
 */
export function athenaWorkGroupName(scope: Construct): string {
  const env = envName(scope)
  return `${env ? `kukan-${env}` : 'kukan'}-logs`
}

/** Capitalize the first letter (e.g. `dev` → `Dev`) for Stage / construct ids. */
export function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
