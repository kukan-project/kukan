/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { eq, ilike, sql, count } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag } from '@kukan/db'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

export class TagService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string }) {
    const { offset = 0, limit = 100, q } = params

    const where = q ? ilike(tag.name, `%${q}%`) : undefined

    const [{ total }] = await this.db.select({ total: count() }).from(tag).where(where)

    const items = await this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTag.packageId})`.as('package_count'),
      })
      .from(tag)
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .where(where)
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      .limit(limit)
      .offset(offset)

    return {
      items,
      total,
      offset,
      limit,
    } as PaginatedResult<(typeof items)[0]>
  }

  async getById(id: string) {
    const [result] = await this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTag.packageId})`.as('package_count'),
      })
      .from(tag)
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .where(eq(tag.id, id))
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      .limit(1)

    return result || null
  }
}
