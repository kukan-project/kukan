import { NextResponse, type NextRequest } from 'next/server'
import { officePreviewViewerSchema } from '@kukan/shared'
import { siteOrigin } from '@/lib/site-origin'
import { IBIS_OFFICE_BOOT, IBIS_OFFICE_DIR, IBIS_OFFICE_ROOT } from '@/lib/ibis-office'

const OFFICE_ONLINE_VIEWER = 'https://view.officeapps.live.com'

/**
 * The CSP that keeps the Office preview's sandboxed frame in (ADR-065
 * decision 2). A source that names a path must name the host too, and
 * OFFICE_PREVIEW_VIEWER is read at runtime, so both are set per request rather
 * than in next.config.ts. The host is the site's configured origin, which
 * CloudFront's viewers see (it does not pass their Host on), and the request's,
 * for a site reached directly under another name, as by its address.
 *
 * Every page gets `frame-src`, not just a dataset's: the App Router keeps the
 * first document across client navigations, so only the CSP of the page a
 * visitor arrived on is in force. It limits frames to the boot page, the PDF
 * preview and, on an `office-online` site alone, Microsoft's viewer — which a
 * frame could otherwise be navigated to, carrying a document in its URL.
 */
export function proxy(request: NextRequest) {
  const origins = [...new Set([siteOrigin(), requestOrigin(request)])]
  const response = NextResponse.next()
  // All of it, decoded: the boot page is served under other spellings of its
  // path too (`%62oot.html`), and a script or WASM response ignores the CSP
  if (decoded(request.nextUrl.pathname).startsWith(IBIS_OFFICE_ROOT)) {
    response.headers.set('Content-Security-Policy', bootPolicy(origins))
    response.headers.set('X-DNS-Prefetch-Control', 'off')
  } else {
    const frames = origins.flatMap((origin) => [
      `${origin}${IBIS_OFFICE_BOOT}`,
      `${origin}/api/v1/resources/`,
    ])
    if (officePreviewViewerSchema.parse(process.env.OFFICE_PREVIEW_VIEWER) === 'office-online') {
      frames.push(OFFICE_ONLINE_VIEWER)
    }
    response.headers.set('Content-Security-Policy', `frame-src ${frames.join(' ')}`)
  }
  return response
}

/**
 * From Host alone: CloudFront replaces it, but passes a viewer's
 * X-Forwarded-Host on, which would let anyone put a host of their own in the
 * CSP of a page its HTML cache then serves to everybody. An http source matches
 * https too, so a TLS proxy in front does not matter.
 */
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get('host')
  return host && /^[\w.:[\]-]+$/.test(host)
    ? `${request.nextUrl.protocol}//${host}`
    : request.nextUrl.origin
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
  // files. No exception for prefetches: their responses reach CloudFront's HTML
  // cache, whose key does not hold the header that marks them, and would serve
  // every visitor a page with no CSP
  matcher: ['/((?!api/|_next/static/|_next/image).*)'],
}
