/**
 * KUKAN Fetch Rate Limit
 * Tracks last fetch timestamp per FQDN to enforce per-host rate limiting
 * across multiple workers.
 */

import { pgTable, varchar, timestamp } from 'drizzle-orm/pg-core'

export const fetchRateLimit = pgTable('fetch_rate_limit', {
  fqdn: varchar('fqdn', { length: 255 }).primaryKey(),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }).notNull(),
})
