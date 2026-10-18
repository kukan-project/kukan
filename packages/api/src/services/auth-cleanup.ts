/**
 * Deleting the Better Auth rows nothing will read again.
 *
 * Better Auth deletes expired rows only on the way past them. A session goes
 * when its own token comes back, so one nobody returns to stays for good, with
 * its IP address and User-Agent. Rate-limit counters and verifications are
 * swept table-wide, but only when a counter's window restarts or a
 * verification is looked up; without that traffic they stay too. The worker's
 * hourly sweep deletes all three.
 */

import { lt } from 'drizzle-orm'
import { rateLimit, session, verification, type Database } from '@kukan/db'

export interface AuthCleanup {
  sessions: number
  verifications: number
  rateLimits: number
}

/**
 * Delete expired sessions and verifications, and rate-limit counters last
 * touched more than `rateLimitRetentionMs` ago. Better Auth refuses an expired
 * session or verification already, so those go as soon as they expire.
 */
export async function pruneExpiredAuthRows(
  db: Database,
  rateLimitRetentionMs: number
): Promise<AuthCleanup> {
  // The application's clock, as Better Auth reads expiry by. One after another:
  // the sweep shares the worker's pool with its jobs
  const now = new Date()
  const sessions = await db
    .delete(session)
    .where(lt(session.expiresAt, now))
    .returning({ id: session.id })
  const verifications = await db
    .delete(verification)
    .where(lt(verification.expiresAt, now))
    .returning({ id: verification.id })
  const rateLimits = await db
    .delete(rateLimit)
    .where(lt(rateLimit.lastRequest, now.getTime() - rateLimitRetentionMs))
    .returning({ id: rateLimit.id })
  return {
    sessions: sessions.length,
    verifications: verifications.length,
    rateLimits: rateLimits.length,
  }
}
