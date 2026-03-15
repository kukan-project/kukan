/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { eq, ilike, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag } from '@kukan/db'
import { escapeLike } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

export class TagService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string }) {
    const { offset = 0, limit = 100, q } = params

    const where = q ? ilike(tag.name, `%${escapeLike(q)}%`) : undefined

    const rows = await this.db
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
      .limit(limit)
      .offset(offset)

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
