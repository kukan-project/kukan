/**
 * The Content-Security-Policy of the ibisOffice app's directory (ADR-065
 * decision 2): its boot page, scripts and WASM. An opaque origin even when the
 * boot page is opened directly, outside the frame, and nothing loaded or
 * fetched but the app's directory — not all of 'self', where a request would
 * reach the API with the visitor's cookies.
 *
 * Shared because two places send it: the web's proxy, and on a Web Function
 * site the CloudFront behavior that serves the directory from S3 (ADR-068).
 *
 * @param origins the site's origins, as `publicOrigin` and `trustedOrigins` spell them
 * @param dir the app's directory, `/vendor/ibis-office/<version>/`
 */
export function ibisOfficeBootPolicy(origins: readonly string[], dir: string): string {
  const app = origins.map((origin) => `${origin}${dir}`).join(' ')
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
