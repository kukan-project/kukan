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

/** Per-environment prefix, e.g. `kukan-dev`. */
export function envPrefix(scope: Construct): string {
  const stageName = cdk.Stage.of(scope)?.stageName
  return stageName ? `kukan-${stageName.toLowerCase()}` : 'kukan'
}

/** Env-prefixed resource name, e.g. `kukan-dev-web`. */
export function resourceName(scope: Construct, suffix: string): string {
  return `${envPrefix(scope)}-${suffix}`
}

/** Capitalize the first letter (e.g. `dev` → `Dev`) for Stage / construct ids. */
export function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
