/**
 * KUKAN Body-Limit Middleware
 */

import type { Context, Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { PayloadTooLargeError } from '@kukan/shared'

/** Far above any body the API takes in JSON; a file goes through the upload route */
export const MAX_BODY_BYTES = 1024 * 1024

/** Streamed rather than read whole, under the upload's own cap (MAX_UPLOAD_SIZE) */
const UPLOAD_PATH = /^\/api\/v1\/resources\/[^/]+\/upload$/

/**
 * Only what the upload route streams: anything else sent there is refused
 * before its body is read, and retireConnection speaks for multipart alone.
 */
function isUpload(c: Context): boolean {
  return (
    c.req.method === 'POST' &&
    UPLOAD_PATH.test(c.req.path) &&
    (c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')
  )
}

const limit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => {
    // The rest of the body is never read: see retireConnection
    c.header('Connection', 'close')
    throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes`)
  },
})

/**
 * Refuse a request body over MAX_BODY_BYTES with 413 — apply to `/api/*` ahead
 * of every route.
 *
 * A route reads its body whole before it looks at anything else: a validator
 * parses it before the handler checks who is asking, and Better Auth and the
 * MCP transport take it as it comes. Bounded here, an anonymous request cannot
 * make any of them hold more than this. A declared length is refused unread; a
 * chunked body is counted as it arrives and refused once it passes the cap.
 */
export async function limitBody(c: Context, next: Next) {
  if (isUpload(c)) return next()
  return limit(c, next)
}
