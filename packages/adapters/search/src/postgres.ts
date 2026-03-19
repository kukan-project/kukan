/**
 * KUKAN PostgreSQL Search Adapter
 * ILIKE-based search on package title/notes/name + resource name/description
 * pg_trgm GIN indexes accelerate queries with 3+ characters
 */

import {
  SearchQuery,
  SearchResult,
  DatasetDoc,
  escapeLike,
  groupMatchedResources,
} from '@kukan/shared'
import { type Database, packageTable, organization, packageTag, tag, resource } from '@kukan/db'
import { ilike, eq, and, or, sql, inArray, desc } from 'drizzle-orm'
import { SearchAdapter } from './adapter'

export class PostgresSearchAdapter implements SearchAdapter {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async index(_doc: DatasetDoc): Promise<void> {
    // No-op: data lives directly in the package table
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    const pattern = `%${escapeLike(query.q)}%`
    const hasQuery = query.q.trim().length > 0

    // Build WHERE conditions
    const conditions = [eq(packageTable.state, 'active')]

    if (hasQuery) {
      conditions.push(
        or(
          ilike(packageTable.name, pattern),
          ilike(packageTable.title, pattern),
          ilike(packageTable.notes, pattern),
          sql`EXISTS (
            SELECT 1 FROM ${resource}
            WHERE ${resource.packageId} = ${packageTable.id}
            AND ${resource.state} = 'active'
            AND (${resource.name} ILIKE ${pattern} OR ${resource.description} ILIKE ${pattern})
          )`
        )!
      )
    }

    // Organization filter (by org name)
    if (query.filters?.organization) {
      conditions.push(eq(organization.name, query.filters.organization as string))
    }

    // Tags filter (match packages that have at least one of the specified tags)
    if (query.filters?.tags) {
      const tagNames = query.filters.tags as string[]
      if (tagNames.length > 0) {
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM ${packageTag}
            JOIN ${tag} ON ${packageTag.tagId} = ${tag.id}
            WHERE ${packageTag.packageId} = ${packageTable.id}
            AND ${tag.name} IN ${tagNames}
          )`
        )
      }
    }

    const where = and(...conditions)

    // Count total matching rows
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(packageTable)
      .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
      .where(where!)

    // Fetch matching rows with organization name
    const rows = await this.db
      .select({
        id: packageTable.id,
        name: packageTable.name,
        title: packageTable.title,
        notes: packageTable.notes,
        organization: organization.name,
      })
      .from(packageTable)
      .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
      .where(where!)
      .orderBy(desc(packageTable.updated))
      .limit(limit)
      .offset(offset)

    // Fetch tags and matched resources in parallel
    const packageIds = rows.map((r) => r.id)
    const tagsByPackage: Record<string, string[]> = {}
    let matchedByPackage: ReturnType<typeof groupMatchedResources> = {}

    if (packageIds.length > 0) {
      const [tagRows, matchedRows] = await Promise.all([
        this.db
          .select({
            packageId: packageTag.packageId,
            tagName: tag.name,
          })
          .from(packageTag)
          .innerJoin(tag, eq(packageTag.tagId, tag.id))
          .where(inArray(packageTag.packageId, packageIds)),
        hasQuery
          ? this.db
              .select({
                id: resource.id,
                packageId: resource.packageId,
                name: resource.name,
                description: resource.description,
                format: resource.format,
              })
              .from(resource)
              .where(
                and(
                  inArray(resource.packageId, packageIds),
                  eq(resource.state, 'active'),
                  or(ilike(resource.name, pattern), ilike(resource.description, pattern))
                )
              )
          : Promise.resolve([]),
      ])

      for (const row of tagRows) {
        if (!tagsByPackage[row.packageId]) {
          tagsByPackage[row.packageId] = []
        }
        tagsByPackage[row.packageId].push(row.tagName)
      }

      matchedByPackage = groupMatchedResources(matchedRows)
    }

    const items: DatasetDoc[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title ?? undefined,
      notes: row.notes ?? undefined,
      organization: row.organization ?? undefined,
      tags: tagsByPackage[row.id] ?? [],
      ...(matchedByPackage[row.id] && {
        matchedResources: matchedByPackage[row.id],
      }),
    }))

    return { items, total: count, offset, limit }
  }

  async delete(_id: string): Promise<void> {
    // No-op: deletion handled by database cascade
  }

  async bulkIndex(_docs: DatasetDoc[]): Promise<void> {
    // No-op: data lives directly in the package table
  }
}
