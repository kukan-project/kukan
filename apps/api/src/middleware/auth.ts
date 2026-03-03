/**
 * KUKAN Authentication Middleware
 * Validates session and API tokens
 */

import type { Context, Next } from 'hono'
import { ForbiddenError } from '@kukan/shared'
import type { Auth } from '../auth/auth'

/**
 * Optional authentication - adds user to context if authenticated
 */
export function optionalAuth(auth: Auth) {
  return async (c: Context, next: Next) => {
    // Check for session cookie
    const sessionToken = c.req.header('cookie')?.match(/session=([^;]+)/)?.[1]

    if (sessionToken) {
      try {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        })

        if (session?.user) {
          c.set('user', {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name || session.user.email,
            sysadmin: false, // TODO: Get from database
          })
        }
      } catch (err) {
        // Session invalid, continue without user
        console.warn('Invalid session:', err)
      }
    }

    // TODO: Check for API token in Authorization header
    // const apiToken = c.req.header('Authorization')?.replace('Bearer ', '')

    await next()
  }
}

/**
 * Required authentication - throws error if not authenticated
 */
export function requireAuth(auth: Auth) {
  return async (c: Context, next: Next) => {
    await optionalAuth(auth)(c, async () => {
      const user = c.get('user')
      if (!user) {
        throw new ForbiddenError('Authentication required')
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
