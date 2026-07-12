/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { and, eq, ilike, isNull, notExists, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag } from '@kukan/db'
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
  await db.delete(tag).where(
    and(
      isNull(tag.vocabularyId),
      notExists(
        db
          .select({ one: sql`1` })
          .from(packageTag)
          .where(eq(packageTag.tagId, tag.id))
      )
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
        packageCount: sql<number>`COUNT(DISTINCT ${packageTag.packageId})::int`.as('package_count'),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      })
      .from(tag)
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .where(where)
      .groupBy(tag.id, tag.name, tag.vocabularyId)
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
        packageCount: sql<number>`COUNT(DISTINCT ${packageTag.packageId})::int`.as('package_count'),
      })
      .from(tag)
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .where(eq(tag.id, id))
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      .limit(1)

    return result || null
  }
}
