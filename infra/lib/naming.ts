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
 * Node-context key carrying the site name (ADR-041). KukanSiteStack sets it on
 * itself before creating children, which extends every name derived here to
 * `kukan-<env>-<site>-*` without touching the constructs. Never set on the
 * single-site KukanStack — its names must stay `kukan-<env>-*`.
 */
export const SITE_CONTEXT_KEY = 'kukan:site'

/** Per-environment prefix, e.g. `kukan-dev` (with a site: `kukan-dev-<site>`). */
export function envPrefix(scope: Construct): string {
  const stageName = cdk.Stage.of(scope)?.stageName
  const base = stageName ? `kukan-${stageName.toLowerCase()}` : 'kukan'
  const site = scope.node.tryGetContext(SITE_CONTEXT_KEY) as string | undefined
  return site ? `${base}-${site}` : base
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
