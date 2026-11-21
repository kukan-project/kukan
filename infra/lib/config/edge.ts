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

/** Whether `name` is the zone `zone` itself or a name under it. */
export function isInZone(name: string, zone: string): boolean {
  const z = zone.replace(/\.$/, '').toLowerCase()
  const n = name.toLowerCase()
  return n === z || n.endsWith(`.${z}`)
}

/** A DNS name as CloudFront and ACM take it: labels of letters, digits and hyphens. */
const DOMAIN_NAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

/**
 * The entry's `additionalDomainNames`, checked: each a DNS name, none twice and
 * none `domainName` itself, and only beside a `domainName` (the name of
 * record). Where the global stack would create the certificate, each must be
 * under `hostedZoneName`, the zone it is validated in. [] when none.
 */
export function resolveAdditionalDomainNames(
  entry: Pick<
    SiteConfig,
    'domainName' | 'additionalDomainNames' | 'certificateArn' | 'hostedZoneName'
  >,
  label: string
): string[] {
  const names = entry.additionalDomainNames ?? []
  if (names.length === 0) return []
  if (!entry.domainName) {
    throw new Error(`${label} sets additionalDomainNames without domainName, the name of record`)
  }
  const seen = new Set([entry.domainName.toLowerCase()])
  for (const name of names) {
    if (name.startsWith('*.')) {
      throw new Error(`${label}: additionalDomainNames has "${name}" — wildcards are not supported`)
    }
    if (!DOMAIN_NAME.test(name)) {
      throw new Error(`${label}: additionalDomainNames has "${name}", which is not a DNS name`)
    }
    if (seen.has(name.toLowerCase())) {
      throw new Error(
        `${label}: "${name}" is listed twice across domainName and additionalDomainNames`
      )
    }
    seen.add(name.toLowerCase())
  }
  const zone = entry.hostedZoneName
  const outside = zone && !entry.certificateArn ? names.filter((n) => !isInZone(n, zone)) : []
  if (outside.length > 0) {
    throw new Error(
      `${label}: not under the hosted zone ${zone}, so the global stack cannot validate a ` +
        `certificate for it: ${outside.join(', ')}. Request one us-east-1 certificate holding ` +
        `${siteDomainNames(entry).join(', ')}, put each name's validation CNAME in its own DNS, ` +
        'and paste its ARN as certificateArn'
    )
  }
  return names
}

/** Every name the entry answers on, the name of record first; [] without a domainName. */
export function siteDomainNames(
  entry: Pick<SiteConfig, 'domainName' | 'additionalDomainNames'>
): string[] {
  return entry.domainName ? [entry.domainName, ...(entry.additionalDomainNames ?? [])] : []
}

/** The origin a browser sends from `name`. */
export const httpsOrigin = (name: string) => `https://${name}`

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
