/**
 * Inject the edge-gate config (IP allowlist and/or Basic auth) into the
 * viewer-request CF Function source at synth time. Pure string transform with no
 * CDK deps — shared by the CDN construct and the CF Function unit tests.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOCALE,
  EDGE_CLIENT_IP_HEADER,
  LOCALE_HEADER,
  SUPPORTED_LOCALES,
} from '@kukan/shared'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Returns the CF Function source with ALLOWED / BASIC_AUTH, the locale
 * constants and the client IP header substituted in.
 * Basic credentials are base64-encoded here because CloudFront Functions have no
 * btoa/Buffer at runtime; the full `Basic <base64>` header is injected so the
 * function compares without a per-request concat.
 */
export function loadViewerRequestCode(
  allowedIpRanges?: string[],
  basicAuth?: { username: string; password: string }
): string {
  let src = readFileSync(join(here, 'viewer-request.js'), 'utf-8')
    .replace('var LOCALES = []', `var LOCALES = ${JSON.stringify(SUPPORTED_LOCALES)}`)
    .replace("var DEFAULT_LOCALE = ''", `var DEFAULT_LOCALE = ${JSON.stringify(DEFAULT_LOCALE)}`)
    .replace("var LOCALE_HEADER = ''", `var LOCALE_HEADER = ${JSON.stringify(LOCALE_HEADER)}`)
    .replace(
      "var CLIENT_IP_HEADER = ''",
      `var CLIENT_IP_HEADER = ${JSON.stringify(EDGE_CLIENT_IP_HEADER)}`
    )
  if (allowedIpRanges) {
    src = src.replace('var ALLOWED = []', `var ALLOWED = ${JSON.stringify(allowedIpRanges)}`)
  }
  if (basicAuth) {
    const header = `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}`
    src = src.replace("var BASIC_AUTH = ''", `var BASIC_AUTH = ${JSON.stringify(header)}`)
  }
  return src
}
