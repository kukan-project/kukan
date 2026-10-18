/**
 * Pruning Better Auth's rate-limit counters (`rate_limit`).
 *
 * Better Auth deletes expired rows itself only when an existing key's window
 * restarts, so a counter for an address that never comes back stays for good:
 * a scan from many addresses would grow the table without bound. The worker's
 * hourly sweep deletes what no window still counts.
 */

import { lt } from 'drizzle-orm'
import { rateLimit, type Database } from '@kukan/db'

/** Delete counters last touched more than `olderThanMs` ago; returns how many. */
export async function pruneRateLimits(db: Database, olderThanMs: number): Promise<number> {
  const rows = await db
    .delete(rateLimit)
    .where(lt(rateLimit.lastRequest, Date.now() - olderThanMs))
    .returning({ id: rateLimit.id })
  return rows.length
}
