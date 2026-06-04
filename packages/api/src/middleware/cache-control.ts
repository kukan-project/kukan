/**
 * KUKAN Cache-Control Middleware
 *
 * Default: sets Cache-Control based on HTTP method if not already set.
 *   GET/HEAD  → private, no-cache
 *   Others    → private, no-store
 *
 * publicCache(): opt-in middleware for fully public GET routes.
 *   → public, max-age={maxAge}, stale-while-revalidate={swr}
 *
 * noCache(): opt-in middleware for non-sensitive endpoints (e.g. health check).
 *   → no-cache
 */

import type { Context, MiddlewareHandler, Next } from 'hono'

/**
 * Default cache-control middleware — apply globally via app.use().
 * Skips if a route handler already set Cache-Control (e.g. file stream responses).
 */
export async function cacheControl(c: Context, next: Next) {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD') {
      c.header('Cache-Control', 'private, no-cache')
    } else {
      c.header('Cache-Control', 'private, no-store')
    }
  }
}

/**
 * Public cache middleware for routes that return identical data regardless of auth.
 * Use as route-level middleware: `router.get('/', publicCache(), handler)`
 */
export function publicCache(maxAge = 60, swr = 300): MiddlewareHandler {
  const value = `public, max-age=${maxAge}, stale-while-revalidate=${swr}`
  return async (c, next) => {
    await next()
    // Only cache successful responses — avoid caching transient errors (500, 404, etc.)
    if (c.res.status < 400) {
      c.header('Cache-Control', value)
    }
  }
}

/**
 * No-cache middleware for non-sensitive endpoints (e.g. health check).
 * Omits `private` since the response contains no user-specific data.
 */
export function noCache(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-cache')
  }
}
