/**
 * KUKAN Logger Middleware
 * Simple request logging
 */

import type { Context, Next } from 'hono'

export async function logger(c: Context, next: Next) {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  await next()

  const elapsed = Date.now() - start
  const status = c.res.status

  console.log(`${method} ${path} ${status} ${elapsed}ms`)
}
