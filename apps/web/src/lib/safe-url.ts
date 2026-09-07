/**
 * URL scheme allowlist for user-supplied hrefs.
 *
 * Renders external/user-controlled URLs (dataset source URLs, markdown links,
 * announcement links) as anchors only when the scheme is safe, blocking
 * `javascript:`, `data:`, `vbscript:`, etc. that would otherwise execute script
 * in the app origin when clicked (stored XSS).
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_PROTOCOLS = new Set([...HTTP_PROTOCOLS, 'mailto:'])

// Any absolute URL parses against this base; relative URLs inherit its (safe)
// https scheme. The host is irrelevant — only the resolved protocol is used.
const RELATIVE_BASE = 'https://relative.invalid/'

/**
 * Returns the URL if it is safe to use as an href, otherwise `undefined`.
 *
 * Safe = a relative URL (path / query / fragment / protocol-relative) or an
 * absolute URL with an http(s)/mailto scheme. Parsing delegates to the WHATWG
 * URL parser, which applies the same normalization browsers use before acting
 * on an href (strips ASCII tab/newline and leading C0 controls, lowercases the
 * scheme), so `java\tscript:`, `  javascript:`, and `JaVaScRiPt:` are caught.
 */
export function safeExternalHref(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string' || url.trim() === '') return undefined

  let protocol: string
  try {
    protocol = new URL(url, RELATIVE_BASE).protocol
  } catch {
    return undefined
  }

  return ALLOWED_PROTOCOLS.has(protocol) ? url : undefined
}

/**
 * The parsed URL when it is an absolute http(s) one, otherwise `undefined`.
 *
 * What a link claiming to point at another site needs, and narrower than
 * {@link safeExternalHref} on both counts: `mailto:` is not a site, and a
 * relative URL is this one. Callers get the `URL` back because a link like that
 * usually has something to say about its host.
 */
export function externalHttpUrl(url: string | null | undefined): URL | undefined {
  if (typeof url !== 'string' || url.trim() === '') return undefined

  let parsed: URL
  try {
    // No base: a relative URL throws here rather than inheriting a scheme.
    parsed = new URL(url)
  } catch {
    return undefined
  }

  return HTTP_PROTOCOLS.has(parsed.protocol) ? parsed : undefined
}
