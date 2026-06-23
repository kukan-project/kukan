/**
 * Inject the edge-gate config (IP allowlist and/or Basic auth) into the
 * viewer-request CF Function source at synth time. Pure string transform with no
 * CDK deps — shared by the CDN construct and the CF Function unit tests.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Returns the CF Function source with ALLOWED / BASIC_AUTH substituted in.
 * Basic credentials are base64-encoded here because CloudFront Functions have no
 * btoa/Buffer at runtime; the full `Basic <base64>` header is injected so the
 * function compares without a per-request concat.
 */
export function loadViewerRequestCode(
  allowedIpRanges?: string[],
  basicAuth?: { username: string; password: string }
): string {
  let src = readFileSync(join(here, 'viewer-request.js'), 'utf-8')
  if (allowedIpRanges && allowedIpRanges.length > 0) {
    src = src.replace('var ALLOWED = []', `var ALLOWED = ${JSON.stringify(allowedIpRanges)}`)
  }
  if (basicAuth) {
    const header = `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}`
    src = src.replace("var BASIC_AUTH = ''", `var BASIC_AUTH = ${JSON.stringify(header)}`)
  }
  return src
}
