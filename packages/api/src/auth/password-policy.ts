/**
 * Server-side enforcement of the password strength policy (@kukan/shared).
 *
 * The client-side meter can be bypassed, so every Better Auth endpoint that
 * sets a password passes through here. Callers get the `PASSWORD_TOO_WEAK`
 * code and render their own localized text — the strength feedback itself is
 * produced client-side, where the locale is known.
 */

import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import {
  checkPasswordGuessability,
  passwordLength,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '@kukan/shared'

/**
 * Endpoints where `password` means one being set. Everywhere else that field
 * carries the password already on the account — sign-in, account deletion —
 * and scoring those would lock out the very users this policy exists to have
 * let in. A `newPassword` needs no such list: nothing verifies with that name,
 * so an endpoint nobody thought of (an admin reset, the reset flow that does
 * not exist yet) is covered the day it appears rather than passing unnoticed.
 */
const CREATION_PATHS = new Set([
  '/sign-up/email',
  '/admin/create-user',
  // The email-OTP plugin's reset is the one endpoint that names a *new*
  // password `password`. Listed before the plugin is enabled, because enabling
  // it otherwise creates an unscored path and nothing says so
  '/email-otp/reset-password',
])

export const enforcePasswordPolicy = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined
  if (!body) return

  const password =
    typeof body.newPassword === 'string'
      ? body.newPassword
      : CREATION_PATHS.has(ctx.path) && typeof body.password === 'string'
        ? body.password
        : null
  if (password === null) return

  // Length answers first, and by name. This hook runs ahead of Better Auth's
  // own length check, so without these a short password comes back as "too
  // weak" and a long one buys the superlinear cost of scoring it — and
  // `/admin/create-user` has no length check of its own to fall back on.
  // The codes match Better Auth's so callers branch on one vocabulary.
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new APIError('BAD_REQUEST', {
      message: `Password is longer than ${PASSWORD_MAX_LENGTH} characters`,
      code: 'PASSWORD_TOO_LONG',
    })
  }
  if (passwordLength(password) < PASSWORD_MIN_LENGTH) {
    throw new APIError('BAD_REQUEST', {
      message: `Password is shorter than ${PASSWORD_MIN_LENGTH} characters`,
      code: 'PASSWORD_TOO_SHORT',
    })
  }

  const strength = await checkPasswordGuessability(password, await accountHints(ctx, body))
  if (!strength || strength.acceptable) return

  throw new APIError('BAD_REQUEST', {
    message: 'Password is too easy to guess',
    code: 'PASSWORD_TOO_WEAK',
  })
})

/**
 * Account details the new password must not be derived from. Creation paths
 * carry them in the body; a change has only a session, and a reset has neither
 * (the token identifies the user, but not before the endpoint runs).
 */
async function accountHints(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  body: Record<string, unknown>
): Promise<{ email?: string; name?: string; displayName?: string | null }> {
  // The display name rides in `data` on the admin creation path, where Better
  // Auth carries the columns it was told about separately from its own
  const data = (body.data ?? {}) as Record<string, unknown>
  const fromBody = {
    email: asString(body.email),
    name: asString(body.name),
    displayName: asString(body.displayName) ?? asString(data.displayName),
  }
  if (fromBody.email || fromBody.name) return fromBody

  const session = await getSessionFromCtx(ctx).catch(() => null)
  if (!session?.user) return {}
  const { email, name, displayName } = session.user as {
    email: string
    name: string
    displayName?: string | null
  }
  return { email, name, displayName }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
