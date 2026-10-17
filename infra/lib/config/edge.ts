/**
 * The CloudFront edge: when a site is gated, and when the us-east-1 certificate
 * and WAF have to be created rather than supplied (ADR-027, ADR-030).
 */

import type { EnvironmentConfig, SiteConfig } from './types.js'

/** Whether an IP allowlist or Basic auth keeps the site from the public (ADR-027). */
export function isEdgeGated(env: {
  allowedIpRanges?: readonly string[]
  basicAuth?: EnvironmentConfig['basicAuth']
}): boolean {
  return !!(env.allowedIpRanges || env.basicAuth)
}

/** WAF default: ON unless the site is edge-gated (ADR-027). */
export function resolveEnableWaf(
  env: Pick<EnvironmentConfig, 'enableWaf' | 'allowedIpRanges' | 'basicAuth'>
): boolean {
  return env.enableWaf ?? !isEdgeGated(env)
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
