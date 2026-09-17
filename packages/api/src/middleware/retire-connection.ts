/**
 * KUKAN Retire-Connection Middleware
 *
 * retireConnection(): opt-in middleware for routes whose request body is an
 * upload. A refusal there answers while the client is still sending, and the
 * rest of that body has nowhere to go: the server stops reading, and the
 * connection is torn down a moment later. The response has already been
 * written by then, and it says `Connection: keep-alive`. Whatever pools
 * connections in front — the ALB pools its connections to the origin —
 * believes it, hands the socket to the next request, and that request dies on
 * a connection that is already gone. The upload gets its 413 and something
 * unrelated gets a 502.
 *
 * The response header is the only lever available: the app is served through a
 * Next.js route handler, which hands Hono a `Request` and no socket to close.
 */

import type { MiddlewareHandler } from 'hono'

/**
 * Retire the connection when the route refuses.
 * Use as route-level middleware: `router.post('/upload', retireConnection(), handler)`
 *
 * Every refusal, not only the ones raised while the body was still arriving: a
 * refusal has no idea how much of the body was read, and the ones that read
 * none of it — unauthorized, no such resource, a length over the cap — leave
 * the connection in the same state as one refused halfway through. The cost of
 * including the opposite case (a failure after the upload was read in full) is
 * one connection on a request that has already failed.
 */
export function retireConnection(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (c.res.status >= 400) c.header('Connection', 'close')
  }
}
