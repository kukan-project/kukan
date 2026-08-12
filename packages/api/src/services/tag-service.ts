/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { and, eq, ilike, isNull, notExists, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag, packageTable } from '@kukan/db'
import { escapeLike } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Delete free tags (no vocabulary) that are no longer linked to any package.
 * Free tags are created on demand when linked to a package, so unlinked ones
 * are garbage. Vocabulary tags are managed explicitly and never collected.
 * Call inside the same transaction as the operation that removes tag links.
 */
export async function deleteOrphanFreeTags(db: DbOrTx): Promise<void> {
  await db
    .delete(tag)
    .where(
      and(
        isNull(tag.vocabularyId),
        notExists(db.select({}).from(packageTag).where(eq(packageTag.tagId, tag.id)))
      )
    )
}

export class TagService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string; orderBy?: 'packageCount' }) {
    const { offset = 0, limit = 100, q, orderBy } = params

    const where = q ? ilike(tag.name, `%${escapeLike(q)}%`) : undefined

    let query = this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        // Count usage by published (active) packages only — the active-only
        // join means draft/deleted links contribute a NULL and are not counted
        packageCount: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('package_count'),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      })
      .from(tag)
      // Left-join so tags with no active package still appear when they are
      // controlled vocabulary; the active-state predicate lives in the ON clause
      // so it filters counted rows, not the tag itself.
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .leftJoin(
        packageTable,
        and(eq(packageTag.packageId, packageTable.id), eq(packageTable.state, 'active'))
      )
      .where(where)
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      // Free tags surface only when used by an active package (drafts must not
      // leak); vocabulary tags are managed explicitly and always kept (tag_list
      // contract, and never GC'd — see deleteOrphanFreeTags).
      .having(sql`${tag.vocabularyId} IS NOT NULL OR COUNT(DISTINCT ${packageTable.id}) > 0`)
      .$dynamic()

    // Most-used first — tag candidates for AI suggestions (ADR-040)
    if (orderBy === 'packageCount') {
      query = query.orderBy(sql`package_count desc`, tag.name)
    }

    const rows = await query.limit(limit).offset(offset)

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  async getById(id: string) {
    const [result] = await this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('package_count'),
      })
      .from(tag)
      // Same visibility rule as list(): count active usage, hide draft-only free
      // tags, but always keep controlled-vocabulary tags
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .leftJoin(
        packageTable,
        and(eq(packageTag.packageId, packageTable.id), eq(packageTable.state, 'active'))
      )
      .where(eq(tag.id, id))
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      .having(sql`${tag.vocabularyId} IS NOT NULL OR COUNT(DISTINCT ${packageTable.id}) > 0`)
      .limit(1)

    return result || null
  }
}
