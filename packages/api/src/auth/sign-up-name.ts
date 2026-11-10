/**
 * Server-side check of the name a self-registering user picks.
 *
 * `user.name` is the display name in member lists and the admin screens, and
 * the sign-up form narrows it to a slug. Without this the endpoint takes
 * whatever is posted to it — spaces, capitals, a name made to pass for
 * `sysadmin` at a glance.
 */

import { APIError } from 'better-auth/api'
import type { Database } from '@kukan/db'
import { userNameSchema } from '@kukan/shared'
import { userNameTaken } from '../services/user-service'

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

/**
 * Refuse a user whose name another has, however it is being created — sign-up
 * or the admin API. The unique index refuses it anyway, but as a failed insert
 * Better Auth logs as an error and answers with a catch-all the form cannot
 * tell apart. Run where Better Auth creates the row, after its own email check,
 * so an email already registered is answered as that. Two creations racing for
 * one name still meet the index.
 */
export async function refuseTakenName(db: Database, name: unknown): Promise<void> {
  if (typeof name === 'string' && (await userNameTaken(db, name))) {
    throw new APIError('UNPROCESSABLE_ENTITY', {
      message: 'That user name is taken',
      code: 'USER_NAME_TAKEN',
    })
  }
}
