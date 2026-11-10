import { NextResponse, type NextRequest } from 'next/server'
import { cspModeSchema, officePreviewViewerSchema, trustedOrigins } from '@kukan/shared'
import { brandConfig } from '@/brand/brand-config'
import { siteOrigin } from '@/lib/site-origin'
import { buildContentSecurityPolicy, uploadOrigin } from '@/lib/csp'
import { IBIS_OFFICE_DIR, IBIS_OFFICE_ROOT } from '@/lib/ibis-office'

/**
 * The pages' CSP (ADR-071), and the one that keeps the Office preview's
 * sandboxed frame in (ADR-065 decision 2). A source that names a path must
 * name the host too, and OFFICE_PREVIEW_VIEWER and CSP_MODE are read at
 * runtime, so the headers are set per request rather than in next.config.ts.
 *
 * Every page gets the policy, not just a dataset's: the App Router keeps the
 * first document across client navigations, so only the CSP of the page a
 * visitor arrived on is in force. `frame-src` limits frames to the boot page,
 * the PDF preview and, on an `office-online` site alone, Microsoft's viewer —
 * which a frame could otherwise be navigated to, carrying a document in its URL.
 *
 * Under `report-only`, `frame-src` stays enforced as it was, and the full
 * policy goes out beside it as Report-Only; under `enforce` the full policy,
 * which holds `frame-src`, is the one header.
 */
export function proxy(request: NextRequest) {
  const origins = allowedOrigins()
  const response = NextResponse.next()
  // All of it, decoded: the boot page is served under other spellings of its
  // path too (`%62oot.html`), and a script or WASM response ignores the CSP
  if (decoded(request.nextUrl.pathname).startsWith(IBIS_OFFICE_ROOT)) {
    response.headers.set('Content-Security-Policy', bootPolicy(origins))
    response.headers.set('X-DNS-Prefetch-Control', 'off')
    return response
  }
  const officeOnline =
    officePreviewViewerSchema.parse(process.env.OFFICE_PREVIEW_VIEWER) === 'office-online'
  const { policy, frameSrc } = buildContentSecurityPolicy({
    origins,
    officeOnline,
    ga: Boolean(brandConfig.gaMeasurementId),
    dev: process.env.NODE_ENV === 'development',
    storageOrigin: uploadOrigin({
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_BUCKET: process.env.S3_BUCKET,
      S3_REGION: process.env.S3_REGION,
    }),
    brandExtra: brandConfig.csp,
  })
  if (cspModeSchema.parse(process.env.CSP_MODE) === 'enforce') {
    response.headers.set('Content-Security-Policy', policy)
  } else {
    response.headers.set('Content-Security-Policy', `frame-src ${frameSrc}`)
    response.headers.set('Content-Security-Policy-Report-Only', policy)
  }
  return response
}

/**
 * BETTER_AUTH_URL's origin, then TRUSTED_ORIGINS, and a Vercel preview's own as
 * sign-in trusts it; never the request's Host (ADR-065 decision 2).
 */
function allowedOrigins(): string[] {
  const vercel = process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []
  return [...new Set([siteOrigin(), ...trustedOrigins(process.env.TRUSTED_ORIGINS), ...vercel])]
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * The boot page's own: an opaque origin even when opened directly, outside
 * the frame, and nothing loaded or fetched but the app's directory — not all
 * of 'self', where a request would reach the API with the visitor's cookies.
 */
function bootPolicy(origins: string[]): string {
  const app = origins.map((origin) => `${origin}${IBIS_OFFICE_DIR}`).join(' ')
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${app} 'wasm-unsafe-eval'`,
    `connect-src ${app}`,
    `img-src ${app} data: blob:`,
    "style-src 'unsafe-inline'",
    `font-src ${app} data:`,
    "frame-ancestors 'self'",
  ].join('; ')
}

export const config = {
  // Not the API (an upload's body would be buffered here) nor Next's static
  // files. `/_next/image` stays in: with the optimizer off, its 404 is a page.
  // No exception for prefetches: their responses reach CloudFront's HTML cache,
  // whose key does not hold the header that marks them, and would serve every
  // visitor a page with no CSP
  matcher: ['/((?!api/|_next/static/).*)'],
}
