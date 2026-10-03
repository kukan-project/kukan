/**
 * KUKAN Authentication Middleware
 * Validates session cookies and API tokens (Bearer)
 */

import type { Context, Next } from 'hono'
import { UnauthorizedError, SESSION_COOKIE_NAME, SysadminRequiredError } from '@kukan/shared'
import type { Auth } from '../auth/auth'
import { ApiTokenService } from '../services/api-token-service'

/** Sign the request in as the user `rawToken` belongs to, when it is a live token. */
async function authenticateToken(c: Context, rawToken: string): Promise<void> {
  try {
    const tokenUser = await new ApiTokenService(c.get('db')).validate(rawToken)
    if (tokenUser) {
      c.set('user', {
        id: tokenUser.id,
        email: tokenUser.email,
        name: tokenUser.name,
        displayName: tokenUser.displayName,
        sysadmin: tokenUser.sysadmin,
      })
    }
  } catch (err) {
    c.get('logger').warn({ err }, 'API token validation error')
  }
}

/**
 * Optional authentication - adds user to context if authenticated.
 * Checks session cookie first, then the API token.
 */
export function optionalAuth(auth: Auth) {
  return async (c: Context, next: Next) => {
    // 1. Check for Better Auth session cookie
    const cookieHeader = c.req.header('cookie') ?? ''
    // Better Auth uses __Secure- prefix on HTTPS (production)
    const hasCookie =
      cookieHeader.includes(`__Secure-${SESSION_COOKIE_NAME}`) ||
      cookieHeader.includes(SESSION_COOKIE_NAME)

    if (hasCookie) {
      try {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        })

        if (session?.user) {
          // Block deleted/inactive users even if session exists
          const state = (session.user as Record<string, unknown>).state
          if (state && state !== 'active') {
            return next()
          }
          c.set('user', {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name || session.user.email,
            displayName: (session.user as Record<string, unknown>).displayName as string | null,
            sysadmin: session.user.role === 'sysadmin',
          })
          return next()
        }
      } catch (err) {
        c.get('logger').warn({ err }, 'Invalid session')
      }
    }

    // 2. Check for API token in Authorization header
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) await authenticateToken(c, authHeader.slice(7))

    await next()
  }
}

/**
 * The token forms CKAN clients send, for the CKAN-compatible API: the bare
 * token in `Authorization` (ckanapi) or `X-CKAN-API-Key`. Runs after
 * {@link optionalAuth}, so only a request it left signed out is read again.
 *
 * Bare means no scheme: a site behind basic auth has `Authorization: Basic …`
 * on every request, and its CKAN clients send the token in `X-CKAN-API-Key`.
 */
export function ckanTokenAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get('user')) {
      const header = c.req.header('Authorization')?.trim()
      const rawToken =
        header && !/\s/.test(header) ? header : c.req.header('X-CKAN-API-Key') || undefined
      if (rawToken) await authenticateToken(c, rawToken)
    }
    await next()
  }
}

/**
 * Required authentication - returns 401 if not authenticated
 */
export function requireAuth(auth: Auth) {
  return async (c: Context, next: Next) => {
    await optionalAuth(auth)(c, async () => {
      const user = c.get('user')
      if (!user) {
        throw new UnauthorizedError()
      }
      await next()
    })
  }
}

/**
 * Require sysadmin role
 */
export function requireSysadmin(auth: Auth) {
  return async (c: Context, next: Next) => {
    await requireAuth(auth)(c, async () => {
      const user = c.get('user')
      if (!user?.sysadmin) {
        throw new SysadminRequiredError('Sysadmin role required')
      }
      await next()
    })
  }
}
