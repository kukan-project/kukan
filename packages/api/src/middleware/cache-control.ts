/**
 * KUKAN Cache-Control Middleware
 *
 * Default: sets Cache-Control based on HTTP method if not already set.
 *   GET/HEAD  → private, no-cache
 *   Others    → private, no-store
 *
 * publicCache(): opt-in middleware for fully public GET routes.
 *   Anonymous  → public, max-age={maxAge}, stale-while-revalidate={swr}
 *   Authenticated → falls through to the default (private, no-cache) so a
 *     signed-in user's own mutations reflect immediately instead of being
 *     served a stale shared-cache copy.
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
 * Public cache middleware for GET routes whose anonymous response is fully
 * public. The response may still vary by viewer (e.g. visibility-scoped
 * counts): only the anonymous variant is ever marked cacheable, so a shared
 * cache never holds a signed-in user's view.
 * Use as route-level middleware: `router.get('/', publicCache(), handler)`
 */
export function publicCache(maxAge = 60, swr = 300): MiddlewareHandler {
  const value = `public, max-age=${maxAge}, stale-while-revalidate=${swr}`
  return async (c, next) => {
    await next()
    // Skip authenticated requests: a signed-in user (e.g. the dashboard) must see
    // their own mutations immediately, so let them fall through to the default
    // `private, no-cache` instead of a cacheable shared response.
    if (c.get('user')) return
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
