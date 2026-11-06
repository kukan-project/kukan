/**
 * KUKAN Fetch Rate Limit
 * Tracks last fetch timestamp per FQDN to enforce per-host rate limiting
 * across multiple workers.
 */

import { pgTable, varchar, timestamp } from 'drizzle-orm/pg-core'

export const fetchRateLimit = pgTable('fetch_rate_limit', {
  fqdn: varchar('fqdn', { length: 255 }).primaryKey(),
  /** When the host was last fetched: what the interval is measured from. */
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }).notNull(),
  /**
   * The latest turn a run asked for, which may be in the future: the next run
   * to ask is given the turn after it. A run that asked and found the slot free
   * took it as its turn. Null where none has asked since the column was added.
   */
  reservedUntil: timestamp('reserved_until', { withTimezone: true }),
})
