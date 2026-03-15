/**
 * KUKAN Authentication Middleware
 * Validates session cookies and API tokens (Bearer)
 */

import type { Context, Next } from 'hono'
import { UnauthorizedError, ForbiddenError, SESSION_COOKIE_NAME } from '@kukan/shared'
import type { Auth } from '../auth/auth'
import { ApiTokenService } from '../services/api-token-service'

/**
 * Optional authentication - adds user to context if authenticated.
 * Checks session cookie first, then Bearer API token.
 */
export function optionalAuth(auth: Auth) {
  return async (c: Context, next: Next) => {
    // 1. Check for Better Auth session cookie
    const hasCookie = c.req.header('cookie')?.includes(SESSION_COOKIE_NAME)

    if (hasCookie) {
      try {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        })

        if (session?.user) {
          c.set('user', {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name || session.user.email,
            sysadmin: session.user.role === 'sysadmin',
          })
          return next()
        }
      } catch (err) {
        console.warn('Invalid session:', err)
      }
    }

    // 2. Check for API token in Authorization header
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const rawToken = authHeader.slice(7)
      try {
        const db = c.get('db')
        const tokenService = new ApiTokenService(db)
        const tokenUser = await tokenService.validate(rawToken)

        if (tokenUser) {
          c.set('user', {
            id: tokenUser.id,
            email: tokenUser.email,
            name: tokenUser.name,
            sysadmin: tokenUser.sysadmin,
          })
        }
      } catch (err) {
        console.warn('API token validation error:', err)
      }
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
        throw new ForbiddenError('Sysadmin role required')
      }
      await next()
    })
  }
}
