/**
 * Marking search documents stale (ADR-053 §9.3), for the writers that mark
 * many rows at once.
 *
 * Rows are locked in id order before they are updated. The sync clears its
 * marks in the same order, and two statements that lock overlapping rows each
 * in its own order can each hold what the other waits for — a renamed
 * organization's hundreds of datasets against a batch of the sync's clears.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { packageTable, resource, type Database } from '@kukan/db'

/** The ids of `table`'s rows matching `where`, locked in id order */
export function lockedInIdOrder(
  q: Pick<Database, 'select'>,
  table: typeof packageTable | typeof resource,
  where: SQL | undefined
) {
  return q.select({ id: table.id }).from(table).where(where).orderBy(table.id).for('update')
}

/**
 * Mark the search documents of the live datasets `where` selects. Drafts and
 * deleted ones have no document to rewrite — but every row is locked, live or
 * not: a publish or a restore of one of them updates the same row, so it waits
 * for this transaction and then reads what it committed. Left unlocked, one
 * could read the old name, write it and clear its own mark before this
 * commits, and nothing would be left marked to bring the new name in.
 */
export async function markPackageDocs(
  tx: Pick<Database, 'select' | 'update'>,
  where: SQL
): Promise<void> {
  // A statement of its own: as a subquery of the update below, the planner
  // need not run it for rows the state filter has already turned away
  const locked = await lockedInIdOrder(tx, packageTable, where)
  if (locked.length === 0) return
  await tx
    .update(packageTable)
    .set({ docSyncDueAt: sql`NOW()` })
    .where(
      and(
        eq(packageTable.state, 'active'),
        // One array parameter, however many datasets the organization has
        sql`${packageTable.id} = ANY(${sql.param(locked.map((r) => r.id))}::uuid[])`
      )
    )
}
