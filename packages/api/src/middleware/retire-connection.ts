/**
 * KUKAN Retire-Connection Middleware
 */

import type { Context, Next } from 'hono'

/**
 * Answer a refused upload with `Connection: close` — apply globally via app.use().
 *
 * Refusing an upload answers while the client is still sending. The rest of
 * that body has nowhere to go: the server stops reading and the connection is
 * torn down a moment later, but the response went out saying
 * `Connection: keep-alive`. The ALB pools its connections to the origin,
 * believes it, and hands the socket to the next request, which dies on a
 * connection that is already gone — the upload gets its 413 and something
 * unrelated gets a 502.
 *
 * The header is the only lever: the app is served through a Next.js route
 * handler, which hands Hono a `Request` and no socket to close. It reaches the
 * wire because that handler copies response headers onto the Node response,
 * which is where `Connection` takes effect.
 *
 * Keyed on the request rather than the route, so an upload POST to a path that
 * matches nothing is covered too — a 404 is answered without a route, so
 * nothing route-scoped could speak for it. A large body that is not multipart
 * is not covered; nothing sends one today.
 *
 * Every refusal, not only those raised with the body still arriving: a refusal
 * has no idea how much was read, and the ones that read none of it — no such
 * resource, unauthorized, a declared length over the cap — leave the
 * connection in the same state as one refused halfway through.
 */
export async function retireConnection(c: Context, next: Next) {
  await next()
  if (c.res.status < 400) return
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return
  c.header('Connection', 'close')
}
