/**
 * KUKAN Tag Service
 * Business logic for tag management
 */

import { and, eq, ilike, isNull, notExists, sql, type SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { tag, packageTag, packageTable } from '@kukan/db'
import { escapeLike, isUuid } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'
import { packageVisibilitySql, type AuthUser } from '../auth/permissions'

/**
 * ON condition for the package join that counts as tag usage: published
 * (active) packages the viewer may see, so draft/deleted/invisible-private
 * links contribute a NULL and are not counted. Shared by list() and getById()
 * so the visibility rule cannot drift between the list and the detail.
 */
function visibleUsageJoin(visibility: SQL | undefined) {
  return and(
    eq(packageTag.packageId, packageTable.id),
    eq(packageTable.state, 'active'),
    visibility
  )
}

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

  async list(
    params: Omit<PaginationParams, 'limit'> & {
      /** `null` reads them all, as CKAN's tag_list does */
      limit?: number | null
      q?: string
      orderBy?: 'packageCount' | 'name'
      /** Leave out controlled-vocabulary tags, as CKAN's `tag_list` does by default */
      freeOnly?: boolean
    },
    viewer?: AuthUser
  ) {
    const { offset = 0, limit = 100, q, orderBy, freeOnly } = params

    const where = and(
      q ? ilike(tag.name, `%${escapeLike(q)}%`) : undefined,
      freeOnly ? isNull(tag.vocabularyId) : undefined
    )
    const visibility = await packageVisibilitySql(this.db, viewer)

    let query = this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('package_count'),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      })
      .from(tag)
      // Left-join so tags with no visible package still appear when they are
      // controlled vocabulary; the usage predicates live in the ON clause so
      // they filter counted rows, not the tag itself.
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .leftJoin(packageTable, visibleUsageJoin(visibility))
      .where(where)
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      // Free tags surface only when used by a visible active package (drafts
      // and other viewers' private datasets must not leak); vocabulary tags are
      // managed explicitly and always kept (tag_list contract, and never GC'd —
      // see deleteOrphanFreeTags).
      .having(sql`${tag.vocabularyId} IS NOT NULL OR COUNT(DISTINCT ${packageTable.id}) > 0`)
      .$dynamic()

    // Most-used first — tag candidates for AI suggestions (ADR-040)
    if (orderBy === 'packageCount') {
      query = query.orderBy(sql`package_count desc`, tag.name)
    } else if (orderBy === 'name') {
      query = query.orderBy(tag.name, tag.id)
    }

    const rows = await (limit === null ? query : query.limit(limit)).offset(offset)

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  /**
   * A tag by id, or by name among the free tags — CKAN's `tag_show`, which
   * reads a name as a free tag's unless told the vocabulary.
   */
  async getByNameOrId(nameOrId: string, viewer?: AuthUser) {
    const byName = and(eq(tag.name, nameOrId), isNull(tag.vocabularyId))!
    if (!isUuid(nameOrId)) return this.getOne(byName, viewer)
    return (await this.getOne(eq(tag.id, nameOrId), viewer)) ?? this.getOne(byName, viewer)
  }

  async getById(id: string, viewer?: AuthUser) {
    return this.getOne(eq(tag.id, id), viewer)
  }

  private async getOne(where: SQL, viewer?: AuthUser) {
    const visibility = await packageVisibilitySql(this.db, viewer)
    const [result] = await this.db
      .select({
        id: tag.id,
        name: tag.name,
        vocabularyId: tag.vocabularyId,
        packageCount: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('package_count'),
      })
      .from(tag)
      // Hide free tags with no visible package, but always keep
      // controlled-vocabulary tags (same HAVING contract as list())
      .leftJoin(packageTag, eq(tag.id, packageTag.tagId))
      .leftJoin(packageTable, visibleUsageJoin(visibility))
      .where(where)
      .groupBy(tag.id, tag.name, tag.vocabularyId)
      .having(sql`${tag.vocabularyId} IS NOT NULL OR COUNT(DISTINCT ${packageTable.id}) > 0`)
      .limit(1)

    return result || null
  }
}
