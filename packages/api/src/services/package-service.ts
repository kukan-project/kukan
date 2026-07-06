/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { eq, and, or, sql, getTableColumns, inArray, desc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  tag,
  packageTag,
  organization,
  resource,
  resourcePipeline,
  group,
  packageGroup,
} from '@kukan/db'
import { NotFoundError, ValidationError, ConflictError, isUuid } from '@kukan/shared'
import type { PaginationParams, PaginatedResult, FacetCounts } from '@kukan/shared'
import type { SearchFacets, MatchedResource } from '@kukan/search-adapter'
import type { CreatePackageInput, UpdatePackageInput } from '@kukan/shared'
import { hasOrgMembership, type AuthUser } from '../auth/permissions'

type PackageRow = typeof packageTable.$inferSelect
export type PackageAuthorize = (pkg: PackageRow) => Promise<void>

export interface PackageFilterParams {
  /** Package IDs from SearchAdapter */
  searchMatchIds?: string[]
  /** Total count from SearchAdapter (used instead of DB COUNT) */
  searchTotal?: number
  /** Matched resources from SearchAdapter, keyed by package ID */
  searchMatchedResources?: Record<string, MatchedResource[]>
  /** Highlighted fields from SearchAdapter, keyed by package ID */
  searchHighlights?: Record<string, { highlightedTitle?: string; highlightedNotes?: string }>
  /** Package IDs that matched via vector search only (ADR-034) */
  searchSemanticIds?: string[]
  /** Package state filter (default: 'active') */
  state?: 'active' | 'deleted'
}

export class PackageService {
  constructor(private db: Database) {}

  /** Build WHERE conditions for package list query */
  private buildConditions(params: PackageFilterParams): SQL[] {
    const conditions: SQL[] = [eq(packageTable.state, params.state ?? 'active')]

    // When search results are provided, filter by matched IDs
    if (params.searchMatchIds && params.searchMatchIds.length > 0) {
      conditions.push(inArray(packageTable.id, params.searchMatchIds))
    }

    return conditions
  }

  async list(params: PaginationParams & PackageFilterParams) {
    const { offset = 0, limit = 20 } = params

    // When search was used but returned no matches, return empty result immediately
    if (params.searchMatchIds !== undefined && params.searchMatchIds.length === 0) {
      return {
        items: [],
        total: params.searchTotal ?? 0,
        offset,
        limit,
      } as PaginatedResult<never>
    }

    const hasSearchResults = params.searchMatchIds && params.searchMatchIds.length > 0

    const conditions = this.buildConditions(params)
    const where = and(...conditions)

    const selectFields = {
      ...getTableColumns(packageTable),
      total: sql<number>`COUNT(*) OVER()::int`.as('total'),
      formats:
        sql<string>`(SELECT COALESCE(string_agg(DISTINCT UPPER("resource"."format"), ',' ORDER BY UPPER("resource"."format")), '') FROM "resource" WHERE "resource"."package_id" = "package"."id" AND "resource"."state" = 'active')`.as(
          'formats'
        ),
      resourceCount:
        sql<number>`(SELECT COUNT(*)::int FROM "resource" WHERE "resource"."package_id" = "package"."id" AND "resource"."state" = 'active')`.as(
          'resource_count'
        ),
      tags: sql<string>`(SELECT COALESCE(string_agg("tag"."name", ',' ORDER BY "tag"."name"), '') FROM "package_tag" JOIN "tag" ON "tag"."id" = "package_tag"."tag_id" WHERE "package_tag"."package_id" = "package"."id")`.as(
        'tags_agg'
      ),
      groups:
        sql<string>`(SELECT COALESCE(string_agg("group"."name" || ':' || COALESCE("group"."title", "group"."name"), ',' ORDER BY "group"."title"), '') FROM "package_group" JOIN "group" ON "group"."id" = "package_group"."group_id" WHERE "package_group"."package_id" = "package"."id")`.as(
          'groups_agg'
        ),
      orgName: organization.name,
      orgTitle: organization.title,
    }

    const baseQuery = this.db
      .select(selectFields)
      .from(packageTable)
      .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
      .where(where)

    // SearchAdapter results: IDs are already paginated and scored
    // DB-only results: apply pagination and default ordering
    const rows = hasSearchResults
      ? await baseQuery
      : await baseQuery.orderBy(desc(packageTable.updated)).limit(limit).offset(offset)

    if (hasSearchResults) {
      // Preserve SearchAdapter score order
      const rowById = new Map(rows.map((r) => [r.id, r]))
      const semanticIds = new Set(params.searchSemanticIds)
      const items = params
        .searchMatchIds!.map((id) => rowById.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map(({ total: _, ...row }) => ({
          ...row,
          ...(params.searchMatchedResources?.[row.id] && {
            matchedResources: params.searchMatchedResources[row.id],
          }),
          ...(params.searchHighlights?.[row.id] && params.searchHighlights[row.id]),
          ...(semanticIds.has(row.id) && { matchSource: 'semantic' as const }),
        }))

      return {
        items,
        total: params.searchTotal ?? items.length,
        offset,
        limit,
      } as PaginatedResult<(typeof items)[0]>
    }

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  /**
   * Enrich SearchAdapter facets with all possible values from DB.
   * SearchAdapter only returns non-zero buckets; this supplements with
   * all active orgs/groups/tags/formats/licenses (count=0 for missing).
   */
  async enrichFacets(facets: SearchFacets): Promise<FacetCounts> {
    const orgCountMap = new Map(facets.organizations.map((o) => [o.name, o.count]))
    const groupCountMap = new Map(facets.groups.map((g) => [g.name, g.count]))
    const tagCountMap = new Map(facets.tags.map((t) => [t.name, t.count]))
    const formatCountMap = new Map(facets.formats.map((f) => [f.name, f.count]))
    const licenseCountMap = new Map(facets.licenses.map((l) => [l.name, l.count]))

    const [allOrgs, allGroups, allTags, allFormats, allLicenses] = await Promise.all([
      this.db
        .select({ name: organization.name, title: organization.title })
        .from(organization)
        .where(eq(organization.state, 'active'))
        .orderBy(organization.title),
      this.db
        .select({ name: group.name, title: group.title })
        .from(group)
        .where(eq(group.state, 'active'))
        .orderBy(group.title),
      this.db
        .select({ name: tag.name })
        .from(tag)
        .where(sql`${tag.vocabularyId} IS NULL`)
        .orderBy(tag.name),
      this.db
        .selectDistinct({ format: sql<string>`UPPER(${resource.format})`.as('format') })
        .from(resource)
        .where(
          and(
            eq(resource.state, 'active'),
            sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
          )
        )
        .orderBy(sql`UPPER(${resource.format})`),
      this.db
        .selectDistinct({ licenseId: packageTable.licenseId })
        .from(packageTable)
        .where(
          and(
            eq(packageTable.state, 'active'),
            sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`
          )
        )
        .orderBy(packageTable.licenseId),
    ])

    return {
      organizations: allOrgs.map((o) => ({
        name: o.name,
        title: o.title,
        count: orgCountMap.get(o.name) ?? 0,
      })),
      groups: allGroups.map((g) => ({
        name: g.name,
        title: g.title,
        count: groupCountMap.get(g.name) ?? 0,
      })),
      tags: allTags.map((t) => ({
        name: t.name,
        count: tagCountMap.get(t.name) ?? 0,
      })),
      formats: allFormats
        .map((r) => r.format)
        .filter(Boolean)
        .map((f) => ({
          name: f,
          count: formatCountMap.get(f) ?? 0,
        })),
      licenses: allLicenses
        .map((l) => l.licenseId!)
        .filter(Boolean)
        .map((l) => ({
          name: l,
          count: licenseCountMap.get(l) ?? 0,
        })),
    }
  }

  async getByNameOrId(
    nameOrId: string,
    state: 'active' | 'deleted' = 'active',
    opts?: { tx?: Pick<Database, 'select'>; forUpdate?: boolean }
  ) {
    const base = (opts?.tx ?? this.db)
      .select()
      .from(packageTable)
      .where(
        and(
          isUuid(nameOrId)
            ? or(eq(packageTable.id, nameOrId), eq(packageTable.name, nameOrId))
            : eq(packageTable.name, nameOrId),
          eq(packageTable.state, state)
        )
      )
    // When both id and name match different rows, prefer the id match (CKAN compat)
    const qb = isUuid(nameOrId)
      ? base.orderBy(sql`CASE WHEN ${packageTable.id} = ${nameOrId} THEN 0 ELSE 1 END`).limit(1)
      : base.limit(1)

    const [result] = opts?.forUpdate ? await qb.for('update') : await qb

    if (!result) {
      throw new NotFoundError('Package', nameOrId)
    }

    return result
  }

  /**
   * Get package by name or ID with private visibility check.
   * Throws NotFoundError if the package is private and the viewer lacks access.
   */
  async getByNameOrIdWithAccessCheck(
    nameOrId: string,
    viewer?: AuthUser,
    state: 'active' | 'deleted' = 'active'
  ) {
    const pkg = await this.getByNameOrId(nameOrId, state)

    // Private and deleted packages: org member+ or sysadmin
    // (restore/purge operations are separately guarded by editor+/admin+ role checks)
    const requiresMembership = state === 'deleted' || pkg.private

    if (requiresMembership && !(await hasOrgMembership(this.db, pkg.ownerOrg, viewer))) {
      throw new NotFoundError('Package', nameOrId)
    }

    return pkg
  }

  async getDetailByNameOrId(
    nameOrId: string,
    viewer?: AuthUser,
    state: 'active' | 'deleted' = 'active'
  ) {
    const pkg = await this.getByNameOrIdWithAccessCheck(nameOrId, viewer, state)

    const [resources, tags, groups, org] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(resource),
          pipelineStatus: resourcePipeline.status,
        })
        .from(resource)
        .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
        .where(and(eq(resource.packageId, pkg.id), eq(resource.state, 'active')))
        .orderBy(resource.position),
      this.db
        .select({ id: tag.id, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(eq(packageTag.packageId, pkg.id)),
      this.db
        .select({ id: group.id, name: group.name, title: group.title })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(eq(packageGroup.packageId, pkg.id)),
      pkg.ownerOrg
        ? this.db
            .select({
              id: organization.id,
              name: organization.name,
              title: organization.title,
              description: organization.description,
              imageUrl: organization.imageUrl,
            })
            .from(organization)
            .where(and(eq(organization.id, pkg.ownerOrg), eq(organization.state, 'active')))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
    ])

    return { ...pkg, resources, tags, groups, organization: org }
  }

  async create(input: CreatePackageInput, creatorUserId?: string) {
    return await this.db.transaction(async (tx) => {
      // Validate name uniqueness
      const existing = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(eq(packageTable.name, input.name))
        .limit(1)

      if (existing.length > 0) {
        throw new ValidationError('Package name already exists', { name: input.name })
      }

      // Validate ownerOrg if provided
      if (input.ownerOrg) {
        await this.assertOwnerOrgActive(
          tx,
          input.ownerOrg,
          new NotFoundError('Organization', input.ownerOrg)
        )
      }

      // Create package
      const [pkg] = await tx
        .insert(packageTable)
        .values({
          name: input.name,
          title: input.title,
          notes: input.notes,
          url: input.url,
          version: input.version,
          licenseId: input.licenseId,
          author: input.author,
          authorEmail: input.authorEmail,
          maintainer: input.maintainer,
          maintainerEmail: input.maintainerEmail,
          ownerOrg: input.ownerOrg,
          private: input.private,
          type: input.type,
          extras: input.extras,
          creatorUserId,
          state: 'active',
        })
        .returning()

      if (input.tags && input.tags.length > 0) {
        await this.linkTags(tx, pkg.id, input.tags)
      }
      if (input.groups && input.groups.length > 0) {
        await this.linkGroups(tx, pkg.id, input.groups)
      }

      return pkg
    })
  }

  async update(nameOrId: string, input: UpdatePackageInput, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'active', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      // If name is being changed, check uniqueness
      if (input.name && input.name !== existing.name) {
        const duplicate = await tx
          .select({ id: packageTable.id })
          .from(packageTable)
          .where(eq(packageTable.name, input.name))
          .limit(1)

        if (duplicate.length > 0) {
          throw new ValidationError('Package name already exists', { name: input.name })
        }
      }

      // Validate ownerOrg if being changed
      if (input.ownerOrg && input.ownerOrg !== existing.ownerOrg) {
        await this.assertOwnerOrgActive(
          tx,
          input.ownerOrg,
          new NotFoundError('Organization', input.ownerOrg)
        )
      }

      const [updated] = await tx
        .update(packageTable)
        .set({
          name: input.name,
          title: input.title ?? null,
          notes: input.notes ?? null,
          url: input.url ?? null,
          version: input.version ?? null,
          licenseId: input.licenseId ?? null,
          author: input.author ?? null,
          authorEmail: input.authorEmail ?? null,
          maintainer: input.maintainer ?? null,
          maintainerEmail: input.maintainerEmail ?? null,
          ownerOrg: input.ownerOrg,
          private: input.private,
          type: input.type ?? null,
          extras: input.extras ?? {},
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning()

      if (input.tags) {
        await tx.delete(packageTag).where(eq(packageTag.packageId, existing.id))
        await this.linkTags(tx, existing.id, input.tags)
      }
      if (input.groups) {
        await tx.delete(packageGroup).where(eq(packageGroup.packageId, existing.id))
        await this.linkGroups(tx, existing.id, input.groups)
      }

      return updated
    })
  }

  async delete(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'active', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      const [deleted] = await tx
        .update(packageTable)
        .set({
          state: 'deleted',
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning()

      return deleted!
    })
  }

  /** Hard-delete a soft-deleted package and all related data (CASCADE). */
  async purge(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'deleted', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      const [purged] = await tx
        .delete(packageTable)
        .where(eq(packageTable.id, existing.id))
        .returning()
      return purged!
    })
  }

  /** Find-or-create tags by name and link them to a package. */
  private async linkTags(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    packageId: string,
    tags: { name: string }[]
  ) {
    for (const tagInput of tags) {
      let [existingTag] = await tx
        .select()
        .from(tag)
        .where(and(eq(tag.name, tagInput.name), sql`${tag.vocabularyId} IS NULL`))
        .limit(1)

      if (!existingTag) {
        const [newTag] = await tx
          .insert(tag)
          .values({ name: tagInput.name, vocabularyId: null })
          .returning()
        existingTag = newTag
      }

      await tx.insert(packageTag).values({ packageId, tagId: existingTag.id })
    }
  }

  /** Look up active groups by name and link them to a package. Throws if any group is missing. */
  private async linkGroups(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    packageId: string,
    groups: { name: string }[]
  ) {
    for (const groupInput of groups) {
      const [existingGroup] = await tx
        .select({ id: group.id })
        .from(group)
        .where(and(eq(group.name, groupInput.name), eq(group.state, 'active')))
        .limit(1)

      if (!existingGroup) {
        throw new NotFoundError('Group', groupInput.name)
      }

      await tx.insert(packageGroup).values({ packageId, groupId: existingGroup.id })
    }
  }

  /**
   * A package's owner org must be active. Throws the caller-supplied error when it
   * isn't — used by create/update (org being set must exist & be active) and
   * restore (can't resurrect a package under a deleted/purging org). Accepts db or tx.
   */
  private async assertOwnerOrgActive(
    db: Pick<Database, 'select'>,
    ownerOrgId: string,
    error: Error
  ): Promise<void> {
    const [activeOrg] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, ownerOrgId), eq(organization.state, 'active')))
      .limit(1)
    if (!activeOrg) throw error
  }

  /** Restore a soft-deleted package back to active state. */
  async restore(nameOrId: string, authorize?: PackageAuthorize) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId, 'deleted', { tx, forUpdate: true })
      if (authorize) await authorize(existing)

      // Closes a purge race: restoring a package under a 'purging' org would let the
      // in-flight org purge delete the just-restored package and wipe its files.
      if (existing.ownerOrg) {
        await this.assertOwnerOrgActive(
          tx,
          existing.ownerOrg,
          new ConflictError('Cannot restore a package whose organization is not active')
        )
      }

      const [restored] = await tx
        .update(packageTable)
        .set({
          state: 'active',
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning()

      return restored!
    })
  }
}
