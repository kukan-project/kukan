/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { eq, ilike, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag } from '@kukan/db'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

export class TagService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string }) {
    const { offset = 0, limit = 100, q } = params

    let query = this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTag.packageId})`.as('package_count'),
      })
      .from(tag)
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .groupBy(tag.id, tag.name, tag.vocabularyId)

    if (q) {
      query = query.where(ilike(tag.name, `%${q}%`)) as any
    }

    query = query.limit(limit).offset(offset) as any

    const items = await query
    const total = items.length // TODO: Get actual count

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
