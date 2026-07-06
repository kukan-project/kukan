/**
 * KUKAN PostgreSQL Search Adapter
 * ILIKE-based search on package title/notes/name + resource name/description
 * pg_trgm GIN indexes accelerate queries with 3+ characters
 */

import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  ResourceCountQuery,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  MatchedResource,
  ResourceDoc,
  ContentDoc,
  VectorHit,
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE, type SearchFilters } from './adapter'
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
import { ilike, eq, and, or, sql, inArray, asc, desc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/** Default minimum cosine similarity for vector hits. Measured on bge-m3 with
 *  real catalog data: relevant hits sit at ~0.47–0.62, unrelated tail at
 *  ~0.38–0.45. Model-dependent — override via SEARCH_VECTOR_MIN_SIMILARITY and
 *  settle with golden-set evaluation (ADR-034). */
const DEFAULT_VECTOR_MIN_SIMILARITY = 0.45

export interface PostgresSearchAdapterOptions {
  vectorMinSimilarity?: number
}

export class PostgresSearchAdapter implements SearchAdapter {
  private db: Database
  private vectorMinSimilarity: number

  constructor(db: Database, options?: PostgresSearchAdapterOptions) {
    this.db = db
    this.vectorMinSimilarity = options?.vectorMinSimilarity ?? DEFAULT_VECTOR_MIN_SIMILARITY
  }

  async indexPackage(_doc: DatasetDoc): Promise<void> {
    // No-op: data lives directly in the package table
  }

  /** Build WHERE conditions from search query and filters */
  private buildConditions(query: SearchQuery): SQL[] {
    const state = query.filters?.state ?? 'active'
    const conditions: SQL[] = [eq(packageTable.state, state)]
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

  /** Build ORDER BY clause from query sort params */
  private buildOrderBy(query: SearchQuery) {
    if (!query.sortBy) return desc(packageTable.updated)
    const col =
      query.sortBy === 'name'
        ? packageTable.name
        : query.sortBy === 'created'
          ? packageTable.created
          : packageTable.updated
    return query.sortOrder === 'asc' ? asc(col) : desc(col)
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
      .orderBy(this.buildOrderBy(query))
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

  // No-op: PostgreSQL adapter searches directly via SQL.
  // Index write/delete operations are handled by database cascade.
  async deletePackage(_id: string): Promise<void> {}
  async deleteAllPackages(): Promise<void> {}
  async bulkIndexPackages(_docs: DatasetDoc[]): Promise<void> {}
  async indexResource(_doc: ResourceDoc): Promise<void> {}
  async bulkIndexResources(_docs: ResourceDoc[]): Promise<void> {}
  async deleteResource(_resourceId: string): Promise<void> {}
  async deleteAllResources(): Promise<void> {}
  async indexContent(_doc: ContentDoc): Promise<void> {}
  async deleteContent(_resourceId: string): Promise<void> {}
  async deleteAllContents(): Promise<void> {}

  // Not supported in PostgreSQL mode (returns null).
  async getIndexStats() {
    return null
  }
  async getDocument(_index: string, _id: string) {
    return null
  }
  async browseDocuments(_index: string, _options?: Record<string, unknown>) {
    return null
  }
  async getContentChunks() {
    return []
  }
  async browseContentsByResource() {
    return null
  }
  async fetchContentHighlights(
    _chunkDocIds: string[],
    _queryText: string,
    _filters?: SearchFilters
  ): Promise<Record<string, string>> {
    // PostgreSQL fallback produces no content highlights.
    return {}
  }

  async searchByVector(
    vector: number[],
    modelKey: string,
    filters: SearchFilters,
    k: number
  ): Promise<VectorHit[]> {
    // Reuse the keyword-search filter builder (q: '' skips the ILIKE branch)
    const conditions = this.buildConditions({ q: '', filters })
    const vectorParam = JSON.stringify(vector)
    // Cut below the similarity floor — kNN otherwise pads top-k with noise
    const maxDistance = 1 - this.vectorMinSimilarity

    // The CASE guard makes `<=>` evaluate only on rows of the requested vector
    // space — a bare AND leaves the planner free to compute the distance on
    // other rows first, which errors when a model/dimension migration leaves
    // vectors of different dimensions side by side. The expression appears once
    // (ORDER BY references the output alias) so the ~KB-sized vector parameter
    // is bound and the distance computed a single time per row.
    const distance = sql<number>`CASE WHEN ${packageTable.embeddingModel} = ${modelKey}
      THEN ${packageTable.embedding} <=> ${vectorParam}::vector END`

    const rows = await this.db
      .select({ id: packageTable.id, distance: distance.as('distance') })
      .from(packageTable)
      .where(
        and(
          ...conditions,
          sql`${packageTable.embedding} IS NOT NULL`,
          eq(packageTable.embeddingModel, modelKey)
        )
      )
      .orderBy(sql`"distance"`)
      .limit(k)

    // Rows are distance-ascending, so thresholding the k results here is
    // exactly equivalent to a WHERE-clause cut.
    return rows
      .filter((row) => row.distance <= maxDistance)
      .map((row) => ({ id: row.id, similarity: 1 - row.distance }))
  }

  async facetsForIds(ids: string[]): Promise<SearchFacets> {
    return this.computeFacets(inArray(packageTable.id, ids))
  }

  async sumResourceCount(query?: ResourceCountQuery): Promise<number> {
    const conditions = this.buildConditions({ q: query?.q ?? '', filters: query?.filters })

    const [{ count }] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(packageTable)
      .innerJoin(
        resource,
        and(eq(resource.packageId, packageTable.id), eq(resource.state, 'active'))
      )
      .where(and(...conditions))

    return count
  }
}
