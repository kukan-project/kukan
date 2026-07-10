/**
 * First-Run Bootstrap (ADR-038)
 * While the user table is empty, self-registration is forced on and the
 * first sign-up is promoted to sysadmin.
 */

import { and, count, eq, lt } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { systemSetting, user } from '@kukan/db'
import { BOOTSTRAP_CLAIM_STALE_MS } from '../config'
import { REGISTRATION_ENABLED_KEY, type SystemSettingService } from './system-setting'

/** Sentinel row key marking the sysadmin promotion as consumed (not a registry setting) */
const BOOTSTRAP_CLAIM_KEY = 'bootstrap-completed'

// Bootstrap can never restart once a user row exists (deleted users still
// count as rows), so a positive result is cached for the process lifetime.
let userExists = false

/** True while the user table has zero rows. */
export async function isBootstrapActive(db: Database): Promise<boolean> {
  if (userExists) return false
  const [row] = await db.select({ value: count() }).from(user)
  if (row.value > 0) userExists = true
  return !userExists
}

/**
 * 'claimed' — this sign-up won the promotion and must become sysadmin.
 * 'in-progress' — another first sign-up holds a fresh claim; user creation
 *   must be rejected (retryable) so it cannot end bootstrap without a sysadmin.
 * 'inactive' — users already exist; normal sign-up.
 */
export type BootstrapClaimResult = 'claimed' | 'in-progress' | 'inactive'

/**
 * One-shot claim of the first-user sysadmin promotion. Concurrent sign-ups can
 * all observe an empty user table, so the promotion is decided by inserting a
 * sentinel row instead — the unique key constraint guarantees exactly one
 * winner ever (same durable-claim idea as ADR-028).
 */
export async function claimBootstrapPromotion(db: Database): Promise<BootstrapClaimResult> {
  if (!(await isBootstrapActive(db))) return 'inactive'
  const inserted = await db
    .insert(systemSetting)
    .values({ key: BOOTSTRAP_CLAIM_KEY, value: true })
    .onConflictDoNothing()
    .returning({ id: systemSetting.id })
  if (inserted.length > 0) return 'claimed'

  // A claim row while the user table is still empty means an earlier sign-up
  // failed between claiming and creating its user. Steal such stale claims
  // atomically so the bootstrap self-heals; a fresh claim belongs to an
  // in-flight concurrent sign-up and is respected.
  const stolen = await db
    .update(systemSetting)
    .set({ updated: new Date() })
    .where(
      and(
        eq(systemSetting.key, BOOTSTRAP_CLAIM_KEY),
        lt(systemSetting.updated, new Date(Date.now() - BOOTSTRAP_CLAIM_STALE_MS))
      )
    )
    .returning({ id: systemSetting.id })
  return stolen.length > 0 ? 'claimed' : 'in-progress'
}

/** Effective registration flag: forced on while bootstrapping, otherwise the runtime setting. */
export async function isRegistrationAllowed(
  db: Database,
  settings: SystemSettingService
): Promise<boolean> {
  return (await isBootstrapActive(db)) || settings.getSetting(REGISTRATION_ENABLED_KEY)
}

/** Drop the cached state (tests). */
export function resetBootstrapCache(): void {
  userExists = false
}
