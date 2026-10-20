/**
 * KUKAN nosniff Middleware
 *
 * Sets `X-Content-Type-Options: nosniff` on every response the API makes. The
 * content endpoints hand back text drawn from uploaded files (`/text`, `/json`,
 * `/document-*`, the OData feed); without this a browser may sniff such a body
 * as HTML. The web app's global headers set it too, but only while Hono runs
 * inside Next — set here, it holds wherever the app is mounted.
 */

import type { Context, Next } from 'hono'

export async function noSniff(c: Context, next: Next) {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
}
