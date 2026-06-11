/**
 * URL scheme allowlist for user-supplied hrefs.
 *
 * Renders external/user-controlled URLs (dataset source URLs, markdown links,
 * announcement links) as anchors only when the scheme is safe, blocking
 * `javascript:`, `data:`, `vbscript:`, etc. that would otherwise execute script
 * in the app origin when clicked (stored XSS).
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

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
