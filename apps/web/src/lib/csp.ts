import { IBIS_OFFICE_BOOT } from '@/lib/ibis-office'

export const OFFICE_ONLINE_VIEWER = 'https://view.officeapps.live.com'

/** Where gtag.js is loaded from and where it reports to, when a brand has GA4. */
const GA_SCRIPT_SOURCES = ['https://www.googletagmanager.com']
const GA_CONNECT_SOURCES = [
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://*.googletagmanager.com',
  // Reached only when Google signals / ads linking is on in the property
  'https://*.g.doubleclick.net',
  'https://*.google.com',
  'https://*.google.co.jp',
]

export interface ContentSecurityPolicyInput {
  /** The site's origins as configured: BETTER_AUTH_URL's, then TRUSTED_ORIGINS. */
  origins: string[]
  /** Whether frames may show Microsoft's viewer (OFFICE_PREVIEW_VIEWER=office-online). */
  officeOnline: boolean
  /** Whether the brand loads gtag.js (BrandConfig.gaMeasurementId). */
  ga: boolean
  /** `next dev` evaluates code for Fast Refresh, which production never does. */
  dev: boolean
  /** Where the browser PUTs a file it uploads (uploadOrigin), when that is not the site. */
  storageOrigin?: string
  /** A brand's additions, directive → sources (BrandConfig.csp). */
  brandExtra?: Partial<Record<string, string[]>>
}

/**
 * The origin of a presigned upload URL, which the browser PUTs the file to
 * (use-file-upload.ts): the configured endpoint's — MinIO, or S3 reached by
 * name — or, with none, the address the SDK signs for: the bucket's own
 * virtual-hosted one, or the regional host for a bucket with a dot in its name,
 * which the SDK puts in the path because S3's wildcard certificate cannot cover it.
 */
export function uploadOrigin(env: {
  S3_ENDPOINT?: string
  S3_BUCKET?: string
  S3_REGION?: string
}): string | undefined {
  if (env.S3_ENDPOINT) {
    try {
      return new URL(env.S3_ENDPOINT).origin
    } catch {
      return undefined
    }
  }
  if (!env.S3_BUCKET) return undefined
  const regional = `s3.${env.S3_REGION || 'ap-northeast-1'}.amazonaws.com`
  return env.S3_BUCKET.includes('.')
    ? `https://${regional}`
    : `https://${env.S3_BUCKET}.${regional}`
}

export interface ContentSecurityPolicy {
  /** The full policy, serialized. */
  policy: string
  /** The value of its `frame-src`, which stays enforced whatever CSP_MODE says. */
  frameSrc: string
}

/**
 * What a page may frame: the ibisOffice boot page, the PDF preview (a resource
 * download URL) and, on an `office-online` site alone, Microsoft's viewer
 * (ADR-065 decision 2).
 */
function frameSources(origins: string[], officeOnline: boolean): string[] {
  const frames = origins.flatMap((origin) => [
    `${origin}${IBIS_OFFICE_BOOT}`,
    `${origin}/api/v1/resources/`,
  ])
  if (officeOnline) frames.push(OFFICE_ONLINE_VIEWER)
  return frames
}

/**
 * The pages' policy (ADR-071). No nonce: the App Router's inline scripts cannot
 * be hashed, and a nonce would make every page unique, which the CDN's HTML
 * cache (ADR-027) cannot serve. What `'unsafe-inline'` leaves is the rest —
 * where a script may be loaded from, where data may be sent, what may be
 * framed or embedded.
 *
 * `img-src` admits any host: organizations and groups show an image by a URL
 * their editors type, and a brand's logo may sit on its own host.
 *
 * `frameSrc` is returned beside the policy so that the enforced `frame-src`
 * header under report-only is the same list, a brand's additions included.
 */
export function buildContentSecurityPolicy(
  input: ContentSecurityPolicyInput
): ContentSecurityPolicy {
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        "'unsafe-inline'",
        "'wasm-unsafe-eval'",
        ...(input.dev ? ["'unsafe-eval'"] : []),
        ...(input.ga ? GA_SCRIPT_SOURCES : []),
      ],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:', 'http:']],
    ['font-src', ["'self'", 'data:']],
    [
      'connect-src',
      [
        "'self'",
        ...(input.storageOrigin ? [input.storageOrigin] : []),
        ...(input.ga ? GA_CONNECT_SOURCES : []),
      ],
    ],
    ['worker-src', ["'self'"]],
    ['frame-src', frameSources(input.origins, input.officeOnline)],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
  ]
  for (const [directive, sources] of Object.entries(input.brandExtra ?? {})) {
    if (!sources?.length) continue
    const own = directives.find(([name]) => name === directive)
    if (own) own[1].push(...sources)
    else directives.push([directive, [...sources]])
  }
  const serialize = ([name, sources]: [string, string[]]) => `${name} ${sources.join(' ')}`
  return {
    policy: directives.map(serialize).join('; '),
    frameSrc: directives.find(([name]) => name === 'frame-src')![1].join(' '),
  }
}
