/**
 * KUKAN PostgreSQL Search Adapter
 * ILIKE-based search on package title/notes/name + resource name/description
 * pg_trgm GIN indexes accelerate queries with 3+ characters
 */

import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  MatchedResource,
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE } from './adapter'
import { escapeLike } from '@kukan/shared'
import {
  type Database,
  packageTable,
  organization,
  packageTag,
  tag,
  resource,
  group,
  packageGroup,
} from '@kukan/db'
import { ilike, eq, and, or, sql, inArray, desc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

export class PostgresSearchAdapter implements SearchAdapter {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async index(_doc: DatasetDoc): Promise<void> {
    // No-op: data lives directly in the package table
  }

  /** Build WHERE conditions from search query and filters */
  private buildConditions(query: SearchQuery): SQL[] {
    const conditions: SQL[] = [eq(packageTable.state, 'active')]
    const hasQuery = query.q.trim().length > 0

    if (hasQuery) {
      const pattern = `%${escapeLike(query.q)}%`
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

    // Name prefix filter
    if (query.filters?.name) {
      conditions.push(ilike(packageTable.name, `${escapeLike(query.filters.name)}%`))
    }

    // Organization filter (EXISTS subquery so it works in facet queries without JOIN)
    if (query.filters?.organizations?.length) {
      const orgNames = query.filters.organizations
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${organization}
          WHERE ${organization.id} = ${packageTable.ownerOrg}
          AND ${organization.name} IN ${orgNames}
        )`
      )
    }

    // Tags filter (AND — each selected tag must be present)
    if (query.filters?.tags?.length) {
      const tagNames = query.filters.tags
      const count = tagNames.length
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${packageTag}
          JOIN ${tag} ON ${packageTag.tagId} = ${tag.id}
          WHERE ${packageTag.packageId} = ${packageTable.id}
          AND ${tag.name} IN ${tagNames}
          HAVING COUNT(DISTINCT ${tag.name}) = ${count}
        )`
      )
    }

    // Formats filter (AND — each selected format must be present)
    if (query.filters?.formats?.length) {
      const fmts = query.filters.formats.map((f) => f.toUpperCase())
      const count = fmts.length
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${resource}
          WHERE ${resource.packageId} = ${packageTable.id}
          AND ${resource.state} = 'active'
          AND UPPER(${resource.format}) IN ${fmts}
          HAVING COUNT(DISTINCT UPPER(${resource.format})) = ${count}
        )`
      )
    }

    // License filter (OR — a package has one license, AND would always be empty for 2+)
    if (query.filters?.licenses?.length) {
      conditions.push(inArray(packageTable.licenseId, query.filters.licenses))
    }

    // Groups filter (AND — each selected group must be present)
    if (query.filters?.groups?.length) {
      const groupNames = query.filters.groups
      const count = groupNames.length
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${packageGroup}
          JOIN ${group} ON ${packageGroup.groupId} = ${group.id}
          WHERE ${packageGroup.packageId} = ${packageTable.id}
          AND ${group.name} IN ${groupNames}
          HAVING COUNT(DISTINCT ${group.name}) = ${count}
        )`
      )
    }

    // Visibility: exclude private unless in allowed orgs
    if (query.filters?.excludePrivate) {
      if (query.filters.allowPrivateOrgIds?.length) {
        conditions.push(
          or(
            eq(packageTable.private, false),
            inArray(packageTable.ownerOrg, query.filters.allowPrivateOrgIds)
          )!
        )
      } else {
        conditions.push(eq(packageTable.private, false))
      }
    }

    // my_org filter
    if (query.filters?.ownerOrgIds?.length) {
      conditions.push(inArray(packageTable.ownerOrg, query.filters.ownerOrgIds))
    }

    // Explicit private filter
    if (query.filters?.isPrivate !== undefined) {
      conditions.push(eq(packageTable.private, query.filters.isPrivate))
    }

    // Creator filter
    if (query.filters?.creatorUserId) {
      conditions.push(eq(packageTable.creatorUserId, query.filters.creatorUserId))
    }

    return conditions
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    const hasQuery = query.q.trim().length > 0
    const pattern = hasQuery ? `%${escapeLike(query.q)}%` : ''

    const conditions = this.buildConditions(query)
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
    const matchedByPackage: Record<string, MatchedResource[]> = {}

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

      // Group matched resources by package and cap per MAX_MATCHED_RESOURCES_PER_PACKAGE
      for (const row of matchedRows) {
        if (!matchedByPackage[row.packageId]) {
          matchedByPackage[row.packageId] = []
        }
        if (matchedByPackage[row.packageId].length < MAX_MATCHED_RESOURCES_PER_PACKAGE) {
          matchedByPackage[row.packageId].push({
            id: row.id,
            name: row.name ?? undefined,
            description: row.description ?? undefined,
            format: row.format ?? undefined,
          })
        }
      }
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

    // Compute facets if requested
    let facets: SearchFacets | undefined
    if (query.facets) {
      facets = await this.computeFacets(where!)
    }

    return { items, total: count, offset, limit, ...(facets && { facets }) }
  }

  /** Compute facet counts via SQL aggregations */
  private async computeFacets(where: SQL): Promise<SearchFacets> {
    const [orgRows, tagRows, formatRows, licenseRows, groupRows] = await Promise.all([
      // Organization facet
      this.db
        .select({
          name: organization.name,
          count: sql<number>`COUNT(*)::int`.as('count'),
        })
        .from(packageTable)
        .innerJoin(organization, eq(packageTable.ownerOrg, organization.id))
        .where(where)
        .groupBy(organization.name),

      // Tags facet
      this.db
        .select({
          name: tag.name,
          count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
        })
        .from(packageTable)
        .innerJoin(packageTag, eq(packageTag.packageId, packageTable.id))
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(where)
        .groupBy(tag.name),

      // Formats facet
      this.db
        .select({
          name: sql<string>`UPPER(${resource.format})`.as('name'),
          count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
        })
        .from(packageTable)
        .innerJoin(
          resource,
          and(eq(resource.packageId, packageTable.id), eq(resource.state, 'active'))
        )
        .where(and(where, sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`))
        .groupBy(sql`UPPER(${resource.format})`),

      // Licenses facet
      this.db
        .select({
          name: packageTable.licenseId,
          count: sql<number>`COUNT(*)::int`.as('count'),
        })
        .from(packageTable)
        .where(
          and(where, sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`)
        )
        .groupBy(packageTable.licenseId),

      // Groups facet
      this.db
        .select({
          name: group.name,
          count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
        })
        .from(packageTable)
        .innerJoin(packageGroup, eq(packageGroup.packageId, packageTable.id))
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(where)
        .groupBy(group.name),
    ])

    const toBuckets = (rows: { name: string | null; count: number }[]): SearchFacetBucket[] =>
      rows.filter((r) => r.name != null).map((r) => ({ name: r.name!, count: r.count }))

    return {
      organizations: toBuckets(orgRows),
      tags: toBuckets(tagRows),
      formats: toBuckets(formatRows),
      licenses: toBuckets(licenseRows),
      groups: toBuckets(groupRows),
    }
  }

  async delete(_id: string): Promise<void> {
    // No-op: deletion handled by database cascade
  }

  async deleteAll(): Promise<void> {
    // No-op: data lives directly in the package table
  }

  async bulkIndex(_docs: DatasetDoc[]): Promise<void> {
    // No-op: data lives directly in the package table
  }
}
