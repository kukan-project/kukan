/**
 * KUKAN Announcement Service
 * Business logic for announcement management
 */

import { eq, sql, getTableColumns, lte, isNotNull, and, desc } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { announcement } from '@kukan/db'
import { NotFoundError } from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from '@kukan/shared'

export class AnnouncementService {
  constructor(private db: Database) {}

  /**
   * List announcements with pagination.
   * @param params.publishedOnly - true: only published (published_at <= NOW()), false: all (dashboard use)
   */
  async list(params: PaginationParams & { publishedOnly?: boolean }) {
    const { offset = 0, limit = 20, publishedOnly = true } = params

    const where = publishedOnly
      ? and(isNotNull(announcement.publishedAt), lte(announcement.publishedAt, new Date()))
      : undefined

    const orderBy = publishedOnly ? desc(announcement.publishedAt) : desc(announcement.created)

    const rows = await this.db
      .select({
        ...getTableColumns(announcement),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      })
      .from(announcement)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  async getById(id: string) {
    const [result] = await this.db
      .select()
      .from(announcement)
      .where(eq(announcement.id, id))
      .limit(1)

    if (!result) {
      throw new NotFoundError('Announcement', id)
    }

    return result
  }

  async create(input: CreateAnnouncementInput) {
    const [created] = await this.db
      .insert(announcement)
      .values({
        title: input.title,
        category: input.category,
        link: input.link || null,
        publishedAt: input.publishedAt ?? null,
      })
      .returning()

    return created
  }

  async update(id: string, input: UpdateAnnouncementInput) {
    const existing = await this.getById(id)

    const [updated] = await this.db
      .update(announcement)
      .set({
        title: input.title,
        category: input.category,
        link: input.link || null,
        publishedAt: input.publishedAt ?? null,
        updated: new Date(),
      })
      .where(eq(announcement.id, existing.id))
      .returning()

    return updated
  }

  async delete(id: string) {
    const [deleted] = await this.db.delete(announcement).where(eq(announcement.id, id)).returning()

    if (!deleted) {
      throw new NotFoundError('Announcement', id)
    }

    return { success: true }
  }
}
