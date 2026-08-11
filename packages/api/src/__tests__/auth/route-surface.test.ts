/**
 * Better Auth mounts its own routes, and a version bump can add one. The
 * denylist in auth-surface.ts fails open when that happens: the new route goes
 * live and nobody looks at it — which is how /update-user stayed open (#390).
 *
 * So the routes Better Auth actually mounts are compared against a table that
 * classifies every one of them. A path in neither fails the run, and the
 * dependabot PR that raised the version is where someone decides which group it
 * belongs to.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { BetterAuthOptions } from 'better-auth'
import { createAuth } from '../../auth/auth'
import { authSurface } from '../../middleware/auth-surface'
import { errorHandler } from '../../middleware/error-handler'

/** Blocked by authSurface; middleware/auth-surface.ts says why. */
const BLOCKED = [
  '/admin/ban-user',
  '/admin/create-user',
  '/admin/get-user',
  '/admin/has-permission',
  '/admin/impersonate-user',
  '/admin/list-user-sessions',
  '/admin/list-users',
  '/admin/remove-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/set-role',
  '/admin/set-user-password',
  '/admin/stop-impersonating',
  '/admin/unban-user',
  '/admin/update-user',
  '/update-user',
]

/** KUKAN's sign-in, sign-up and password-change flows call these over HTTP. */
const IN_USE = ['/change-password', '/get-session', '/sign-in/email', '/sign-up/email', '/sign-out']

/** Mounted, but the configuration leaves them nothing to do — each refuses
 *  before it touches anything:
 *   - `user.deleteUser` and `user.changeEmail` are not enabled
 *   - no `emailAndPassword.sendResetPassword`, so no reset token is ever issued
 *     and /reset-password has nothing to accept
 *   - no `emailVerification.sendVerificationEmail`, likewise for verification
 *   - no social provider to sign in with, link, unlink or read a token for
 *   - no session `additionalFields`, and Better Auth keeps the columns of its
 *     own session row out of the input schema, so /update-session has no field
 *     it is allowed to set
 *
 *  Every line above is asserted by the config guard below, so this group cannot
 *  quietly become live. */
const INERT = [
  '/account-info',
  '/callback/:id',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/get-access-token',
  '/link-social',
  '/refresh-token',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/:token',
  '/send-verification-email',
  '/sign-in/social',
  '/unlink-account',
  '/update-session',
  '/verify-email',
]

/** Reachable and working, unused by KUKAN, and left open on purpose: each one
 *  reads or discards the caller's own session or accounts, so none is the kind
 *  of write /update-user was. /ok and /error are Better Auth's own health check
 *  and error page. */
const ACCEPTED = [
  '/error',
  '/list-accounts',
  '/list-sessions',
  '/ok',
  '/revoke-other-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/verify-password',
]

const CLASSIFIED = [...BLOCKED, ...IN_USE, ...INERT, ...ACCEPTED]

// A dummy database is enough: building the instance reads the route table and
// runs no query
const auth = createAuth({} as never)

/** The paths Better Auth mounts. Server-only endpoints (setPassword) carry no
 *  path and are not part of the HTTP surface. */
const MOUNTED = Object.values(auth.api as Record<string, { path?: string }>)
  .map((endpoint) => endpoint.path)
  .filter((path): path is string => path !== undefined)

/** The guard matches URLs, so a parameter needs a value: /callback/:id → /callback/x */
function requestPath(path: string): string {
  return `/api/auth${path.replace(/:[^/]+/g, 'x')}`
}

/** The /api/auth wiring from app.ts, with a stub where the auth handler sits.
 *  The stub answers 200 for anything, so a 404 can only be the guard. */
function createApp() {
  const app = new Hono()
  app.use('/api/auth/*', authSurface)
  app.all('/api/auth/*', () => new Response('{"ok":true}', { status: 200 }))
  app.onError(errorHandler)
  return app
}

describe('the Better Auth route table', () => {
  it('classifies every route Better Auth mounts', () => {
    const unclassified = MOUNTED.filter((path) => !CLASSIFIED.includes(path))

    expect(
      unclassified,
      'new Better Auth endpoint — add it to BLOCKED, IN_USE, INERT or ACCEPTED in this file'
    ).toEqual([])
  })

  it('carries no entry for a route that is no longer mounted', () => {
    const stale = CLASSIFIED.filter((path) => !MOUNTED.includes(path))

    expect(stale, 'renamed or dropped upstream — the group still reads as a live decision').toEqual(
      []
    )
  })

  it('puts each path in one group only', () => {
    expect(CLASSIFIED).toHaveLength(new Set(CLASSIFIED).size)
  })
})

describe('authSurface against that table', () => {
  it('blocks the paths classified as blocked, and only those', async () => {
    const app = createApp()

    const blocked: string[] = []
    for (const path of MOUNTED) {
      const res = await app.request(requestPath(path), { method: 'POST' })
      if (res.status === 404) blocked.push(path)
    }

    expect(blocked.sort()).toEqual([...BLOCKED].sort())
  })

  it('reports the block as a Problem Details 404, not as a refusal', async () => {
    const res = await createApp().request('/api/auth/update-user', { method: 'POST' })

    // 403 would confirm the endpoint exists; the point is to not advertise it
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'NOT_FOUND',
      status: 404,
      detail: 'The requested resource was not found',
    })
  })
})

describe('the configuration the inert classification rests on', () => {
  // Widened: `auth.options` is typed as the literal passed to betterAuth, so
  // the settings this group depends on being absent are not on that type
  const options: BetterAuthOptions = auth.options
  const { user, session, emailAndPassword, emailVerification, socialProviders } = options

  it('leaves self-service account deletion and email change off', () => {
    expect(user?.deleteUser?.enabled).not.toBe(true)
    expect(user?.changeEmail?.enabled).not.toBe(true)
  })

  it('registers no sender, so no reset or verification token is ever issued', () => {
    expect(emailAndPassword?.sendResetPassword).toBeUndefined()
    expect(emailVerification?.sendVerificationEmail).toBeUndefined()
  })

  it('registers no social provider', () => {
    expect(Object.keys(socialProviders ?? {})).toEqual([])
  })

  it('declares no session field of its own', () => {
    expect(Object.keys(session?.additionalFields ?? {})).toEqual([])
  })
})
