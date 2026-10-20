/**
 * Server-side check of the name a self-registering user picks.
 *
 * `user.name` is the display name in member lists and the admin screens, and
 * the sign-up form narrows it to a slug. Without this the endpoint takes
 * whatever is posted to it — spaces, capitals, a name made to pass for
 * `sysadmin` at a glance.
 */

import { APIError } from 'better-auth/api'
import { userNameSchema } from '@kukan/shared'

export function enforceSignUpName(path: string, body: unknown): void {
  if (path !== '/sign-up/email') return
  const name = (body as Record<string, unknown> | undefined)?.name
  const result = userNameSchema.safeParse(name)
  if (result.success) return
  throw new APIError('BAD_REQUEST', {
    message: result.error.issues[0]?.message ?? 'Invalid name',
    code: 'INVALID_USER_NAME',
  })
}
