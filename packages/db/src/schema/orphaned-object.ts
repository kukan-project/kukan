/**
 * KUKAN Orphaned Object Schema
 *
 * Storage keys the sweep is responsible for, of two kinds.
 *
 * **Replaced** (ADR-043). Keys are unique to the run that wrote them, so moving
 * a pointer orphans the old object rather than overwriting it — and it cannot
 * be deleted at that moment, because a request that already resolved the old
 * key is still reading it, across several Range requests for a Parquet. The
 * writer parks the key here in the same statement that moves the pointer.
 *
 * **Not yet created** (ADR-045). A key is recorded before its object is
 * written, and the record removed once a pointer references it. A process that
 * dies in between leaves the record, which is how an object nothing points at
 * becomes reachable at all — without it there is no path back to it.
 *
 * The sweep reduces both to one question: does any pointer reference this
 * object now? So nothing has to tell them apart, and no column does.
 */

import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const orphanedObject = pgTable(
  'orphaned_object',
  {
    key: text('key').primaryKey(),
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * When the sweep may act on this key. Set by the writer rather than derived
     * from `orphaned_at` and one global retention, because the two kinds wait
     * for different reasons: a replaced key waits out readers that already
     * resolved it, a not-yet-created one waits out the write that may still be
     * running. Both are an hour today, and tuning either for its own reason
     * must not move the other (ADR-045 §2).
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_orphaned_object_expires').on(table.expiresAt)]
)
