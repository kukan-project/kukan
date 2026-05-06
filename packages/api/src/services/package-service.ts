/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { eq, and, sql, getTableColumns, inArray, desc } from 'drizzle-orm'
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
  userOrgMembership,
} from '@kukan/db'
import { NotFoundError, ValidationError, isUuid } from '@kukan/shared'
import type { PaginationParams, PaginatedResult, FacetCounts } from '@kukan/shared'
import type { SearchFacets, MatchedResource } from '@kukan/search-adapter'
import type { CreatePackageInput, UpdatePackageInput, PatchPackageInput } from '@kukan/shared'

interface ViewerContext {
  userId?: string
  sysadmin?: boolean
}

export interface PackageFilterParams {
  /** Package IDs from SearchAdapter */
  searchMatchIds?: string[]
  /** Total count from SearchAdapter (used instead of DB COUNT) */
  searchTotal?: number
  /** Matched resources from SearchAdapter, keyed by package ID */
  searchMatchedResources?: Record<string, MatchedResource[]>
  /** Highlighted fields from SearchAdapter, keyed by package ID */
  searchHighlights?: Record<string, { highlightedTitle?: string; highlightedNotes?: string }>
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
      const items = params
        .searchMatchIds!.map((id) => rowById.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map(({ total: _, ...row }) => ({
          ...row,
          ...(params.searchMatchedResources?.[row.id] && {
            matchedResources: params.searchMatchedResources[row.id],
          }),
          ...(params.searchHighlights?.[row.id] && params.searchHighlights[row.id]),
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

  async getByNameOrId(nameOrId: string, state: 'active' | 'deleted' = 'active') {
    const [result] = await this.db
      .select()
      .from(packageTable)
      .where(
        and(
          isUuid(nameOrId) ? eq(packageTable.id, nameOrId) : eq(packageTable.name, nameOrId),
          eq(packageTable.state, state)
        )
      )
      .limit(1)

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
    viewer?: ViewerContext,
    state: 'active' | 'deleted' = 'active'
  ) {
    const pkg = await this.getByNameOrId(nameOrId, state)

    // Private and deleted packages: org member+ or sysadmin
    // (restore/purge operations are separately guarded by editor+/admin+ role checks)
    const requiresMembership = (state === 'deleted' || pkg.private) && !viewer?.sysadmin

    if (requiresMembership) {
      if (!viewer?.userId || !pkg.ownerOrg) {
        throw new NotFoundError('Package', nameOrId)
      }
      const [membership] = await this.db
        .select({ id: userOrgMembership.id })
        .from(userOrgMembership)
        .where(
          and(
            eq(userOrgMembership.userId, viewer.userId),
            eq(userOrgMembership.organizationId, pkg.ownerOrg)
          )
        )
        .limit(1)
      if (!membership) {
        throw new NotFoundError('Package', nameOrId)
      }
    }

    return pkg
  }

  async getDetailByNameOrId(
    nameOrId: string,
    viewer?: ViewerContext,
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

      // Validate owner_org if provided
      if (input.owner_org) {
        const orgExists = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(and(eq(organization.id, input.owner_org), eq(organization.state, 'active')))
          .limit(1)

        if (orgExists.length === 0) {
          throw new NotFoundError('Organization', input.owner_org)
        }
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
          licenseId: input.license_id,
          author: input.author,
          authorEmail: input.author_email,
          maintainer: input.maintainer,
          maintainerEmail: input.maintainer_email,
          ownerOrg: input.owner_org,
          private: input.private,
          type: input.type,
          extras: input.extras,
          creatorUserId,
          state: 'active',
        })
        .returning()

      // Handle tags
      if (input.tags && input.tags.length > 0) {
        for (const tagInput of input.tags) {
          // Find or create tag
          let [existingTag] = await tx
            .select()
            .from(tag)
            .where(and(eq(tag.name, tagInput.name), sql`${tag.vocabularyId} IS NULL`))
            .limit(1)

          if (!existingTag) {
            const [newTag] = await tx
              .insert(tag)
              .values({
                name: tagInput.name,
                vocabularyId: null,
              })
              .returning()
            existingTag = newTag
          }

          // Link tag to package
          await tx.insert(packageTag).values({
            packageId: pkg.id,
            tagId: existingTag.id,
          })
        }
      }

      return pkg
    })
  }

  async update(nameOrId: string, input: UpdatePackageInput) {
    return await this.db.transaction(async (tx) => {
      const existing = await this.getByNameOrId(nameOrId)

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

      // Validate owner_org if being changed
      if (input.owner_org && input.owner_org !== existing.ownerOrg) {
        const orgExists = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(and(eq(organization.id, input.owner_org), eq(organization.state, 'active')))
          .limit(1)

        if (orgExists.length === 0) {
          throw new NotFoundError('Organization', input.owner_org)
        }
      }

      const [updated] = await tx
        .update(packageTable)
        .set({
          name: input.name,
          title: input.title,
          notes: input.notes,
          url: input.url,
          version: input.version,
          licenseId: input.license_id,
          author: input.author,
          authorEmail: input.author_email,
          maintainer: input.maintainer,
          maintainerEmail: input.maintainer_email,
          ownerOrg: input.owner_org,
          private: input.private,
          type: input.type,
          extras: input.extras,
          updated: sql`NOW()`,
        })
        .where(eq(packageTable.id, existing.id))
        .returning()

      // Handle tags update
      if (input.tags) {
        // Remove existing tags
        await tx.delete(packageTag).where(eq(packageTag.packageId, existing.id))

        // Add new tags
        for (const tagInput of input.tags) {
          let [existingTag] = await tx
            .select()
            .from(tag)
            .where(and(eq(tag.name, tagInput.name), sql`${tag.vocabularyId} IS NULL`))
            .limit(1)

          if (!existingTag) {
            const [newTag] = await tx
              .insert(tag)
              .values({
                name: tagInput.name,
                vocabularyId: null,
              })
              .returning()
            existingTag = newTag
          }

          await tx.insert(packageTag).values({
            packageId: existing.id,
            tagId: existingTag.id,
          })
        }
      }

      return updated
    })
  }

  async patch(nameOrId: string, input: PatchPackageInput) {
    const existing = await this.getByNameOrId(nameOrId)

    // Merge with existing data for partial update
    const merged: UpdatePackageInput = {
      name: input.name ?? existing.name,
      title: input.title ?? existing.title ?? undefined,
      notes: input.notes ?? existing.notes ?? undefined,
      url: input.url ?? existing.url ?? undefined,
      version: input.version ?? existing.version ?? undefined,
      license_id: input.license_id ?? existing.licenseId ?? undefined,
      author: input.author ?? existing.author ?? undefined,
      author_email: input.author_email ?? existing.authorEmail ?? undefined,
      maintainer: input.maintainer ?? existing.maintainer ?? undefined,
      maintainer_email: input.maintainer_email ?? existing.maintainerEmail ?? undefined,
      owner_org: input.owner_org ?? existing.ownerOrg ?? undefined,
      private: input.private ?? existing.private,
      type: input.type ?? existing.type ?? undefined,
      extras: input.extras ?? existing.extras ?? undefined,
      tags: input.tags, // Only update if provided
    }

    return await this.update(nameOrId, merged)
  }

  async delete(nameOrId: string) {
    const existing = await this.getByNameOrId(nameOrId)

    const [deleted] = await this.db
      .update(packageTable)
      .set({
        state: 'deleted',
        updated: sql`NOW()`,
      })
      .where(eq(packageTable.id, existing.id))
      .returning()

    return deleted
  }

  /** Hard-delete a soft-deleted package and all related data (CASCADE). */
  async purge(id: string) {
    const [purged] = await this.db.delete(packageTable).where(eq(packageTable.id, id)).returning()

    if (!purged) throw new NotFoundError('Package', id)
    return purged
  }

  /** Restore a soft-deleted package back to active state. */
  async restore(id: string) {
    const [restored] = await this.db
      .update(packageTable)
      .set({
        state: 'active',
        updated: sql`NOW()`,
      })
      .where(eq(packageTable.id, id))
      .returning()

    if (!restored) throw new NotFoundError('Package', id)
    return restored
  }
}
