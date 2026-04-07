/**
 * KUKAN Logger Middleware
 * Structured request/response logging with pino
 */

import type { Context, Next } from 'hono'

export async function logger(c: Context, next: Next) {
  const start = Date.now()
  const log = c.get('logger')

  await next()

  const elapsed = Date.now() - start
  log.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, elapsed },
    'request completed'
  )
}
