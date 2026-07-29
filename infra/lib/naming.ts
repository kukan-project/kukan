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
  const stageName = cdk.Stage.of(scope)?.stageName
  const base = stageName ? `kukan-${stageName.toLowerCase()}` : 'kukan'
  const stack = scope.node.scopes.filter(cdk.Stack.isStack).pop() as
    (cdk.Stack & Partial<SiteScopedStack>) | undefined
  return stack?.kukanSiteName ? `${base}-${stack.kukanSiteName}` : base
}

/** Env-prefixed resource name, e.g. `kukan-dev-web`. */
export function resourceName(scope: Construct, suffix: string): string {
  return `${envPrefix(scope)}-${suffix}`
}

/**
 * SSM parameter name for a shared-box value, e.g. `/kukan/dev/shared/vpc/id`
 * (ADR-041). Derived from the Stage only — deliberately ignores the site
 * context so SiteStacks read the same names SharedStack writes.
 */
export function sharedParamName(scope: Construct, suffix: string): string {
  const stageName = cdk.Stage.of(scope)?.stageName ?? 'kukan'
  return `/kukan/${stageName.toLowerCase()}/shared/${suffix}`
}

/** Capitalize the first letter (e.g. `dev` → `Dev`) for Stage / construct ids. */
export function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
