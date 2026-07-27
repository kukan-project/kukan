/**
 * KUKAN Orphaned Object Schema
 *
 * Storage objects a newer write replaced (ADR-043). Keys are unique to the run
 * that wrote them, so moving a pointer orphans the old object rather than
 * overwriting it — and it cannot be deleted at that moment, because a request
 * that already resolved the old key is still reading it, across several Range
 * requests for a Parquet. The writer parks the key here in the same statement
 * that moves the pointer, and the worker's hourly sweep deletes it once the
 * retention window has passed.
 *
 * The one exception is the Index step's text-head artifact, which is not yet
 * run-scoped and is still overwritten in place.
 */

import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const orphanedObject = pgTable(
  'orphaned_object',
  {
    key: text('key').primaryKey(),
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_orphaned_object_at').on(table.orphanedAt)]
)
