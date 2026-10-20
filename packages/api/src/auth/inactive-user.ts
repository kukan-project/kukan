/**
 * Keeps a user who is no longer active (deleted through KUKAN's admin API) out
 * of Better Auth's own routes, not only the ones behind optionalAuth.
 *
 * Refusing sign-in alone leaves a race: a sign-in that read the user as active
 * can insert its session after the deletion committed. So every route that
 * resolves a session also drops the sessions of a user found inactive, and the
 * route then runs as if signed out — which lets sign-out still clear the cookie.
 */

import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { deleteSessionCookie } from 'better-auth/cookies'

/** Better Auth types its user without the additional fields the row carries. */
function isInactive(owner: object | null | undefined): owner is { id: string } {
  return !!owner && (owner as { state?: string | null }).state !== 'active'
}

export function inactiveUser() {
  return {
    id: 'kukan-inactive-user',
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                // Through the context's adapter, as the admin plugin's ban
                // check does, to see a user created in the same sign-up
                async before(newSession, ctx) {
                  if (!ctx) return
                  const owner = await ctx.context.internalAdapter.findUserById(newSession.userId)
                  if (isInactive(owner)) {
                    throw new APIError('FORBIDDEN', {
                      message: 'This account is no longer active.',
                      code: 'USER_INACTIVE',
                    })
                  }
                },
              },
            },
          },
        },
      }
    },
    hooks: {
      before: [
        {
          // get-session reads the session itself; checked after, on its answer
          matcher: (ctx) => ctx.path !== '/get-session',
          handler: createAuthMiddleware(async (ctx) => {
            // Restored so the route resolves the session as it would have:
            // the lookup here skips the refresh the route may want to do.
            // Cleared instead when inactive, so an earlier hook's cached
            // session can't outlive the rows deleted here.
            const prior = ctx.context.session
            const current = await getSessionFromCtx(ctx, { disableRefresh: true })
            if (current && isInactive(current.user)) {
              await ctx.context.internalAdapter.deleteUserSessions(current.user.id)
              ctx.context.session = null
            } else {
              ctx.context.session = prior
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/get-session',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as { user?: object } | null | undefined
            if (!returned || !isInactive(returned.user)) return
            await ctx.context.internalAdapter.deleteUserSessions(returned.user.id)
            deleteSessionCookie(ctx)
            return ctx.json(null)
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
