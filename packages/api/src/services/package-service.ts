/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { eq, ilike, and, or, sql, getTableColumns, inArray, desc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  tag,
  packageTag,
  organization,
  resource,
  group,
  packageGroup,
  userOrgMembership,
} from '@kukan/db'
import { NotFoundError, ValidationError, isUuid, escapeLike, groupMatchedResources } from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  FacetCounts,
  FacetItem,
} from '@kukan/shared'
import type { CreatePackageInput, UpdatePackageInput, PatchPackageInput } from '@kukan/shared'

interface ViewerContext {
  userId?: string
  sysadmin?: boolean
}

export interface PackageFilterParams {
  q?: string
  name?: string
  owner_org?: string
  group?: string
  tags?: string[]
  formats?: string[]
  license_id?: string
  creator_user_id?: string
  member_user_id?: string
  private?: boolean
  viewer?: ViewerContext
}

export class PackageService {
  constructor(private db: Database) {}

  /**
   * Build WHERE conditions from filter params.
   * Returns null when org/group name resolution fails (indicates empty result).
   * @param exclude — dimension to skip (for facet counting)
   */
  private async buildConditions(
    params: PackageFilterParams,
    exclude?: 'owner_org' | 'group' | 'tags' | 'formats' | 'license_id'
  ): Promise<SQL[] | null> {
    const conditions: SQL[] = [eq(packageTable.state, 'active')]

    if (params.q) {
      const pattern = `%${escapeLike(params.q)}%`
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

    if (params.name) {
      conditions.push(ilike(packageTable.name, `${escapeLike(params.name)}%`))
    }

    if (exclude !== 'owner_org' && params.owner_org) {
      if (isUuid(params.owner_org)) {
        conditions.push(eq(packageTable.ownerOrg, params.owner_org))
      } else {
        const [org] = await this.db
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.name, params.owner_org))
          .limit(1)
        if (org) {
          conditions.push(eq(packageTable.ownerOrg, org.id))
        } else {
          return null
        }
      }
    }

    if (exclude !== 'group' && params.group) {
      const groupCondition = isUuid(params.group)
        ? eq(group.id, params.group)
        : eq(group.name, params.group)
      const [grp] = await this.db
        .select({ id: group.id })
        .from(group)
        .where(groupCondition)
        .limit(1)
      if (grp) {
        const pkgIds = this.db
          .select({ packageId: packageGroup.packageId })
          .from(packageGroup)
          .where(eq(packageGroup.groupId, grp.id))
        conditions.push(inArray(packageTable.id, pkgIds))
      } else {
        return null
      }
    }

    if (exclude !== 'tags' && params.tags && params.tags.length > 0) {
      const tagIds = this.db.select({ id: tag.id }).from(tag).where(inArray(tag.name, params.tags))
      const pkgIdsWithTags = this.db
        .select({ packageId: packageTag.packageId })
        .from(packageTag)
        .where(inArray(packageTag.tagId, tagIds))
      conditions.push(inArray(packageTable.id, pkgIdsWithTags))
    }

    if (exclude !== 'formats' && params.formats && params.formats.length > 0) {
      const pkgIdsWithFormat = this.db
        .select({ packageId: resource.packageId })
        .from(resource)
        .where(
          and(
            eq(resource.state, 'active'),
            inArray(
              sql`UPPER(${resource.format})`,
              params.formats.map((f) => f.toUpperCase())
            )
          )
        )
      conditions.push(inArray(packageTable.id, pkgIdsWithFormat))
    }

    if (exclude !== 'license_id' && params.license_id) {
      conditions.push(eq(packageTable.licenseId, params.license_id))
    }

    if (params.creator_user_id) {
      conditions.push(eq(packageTable.creatorUserId, params.creator_user_id))
    }

    if (params.member_user_id) {
      const orgIds = this.db
        .select({ organizationId: userOrgMembership.organizationId })
        .from(userOrgMembership)
        .where(eq(userOrgMembership.userId, params.member_user_id))
      conditions.push(inArray(packageTable.ownerOrg, orgIds))
    }

    if (typeof params.private === 'boolean') {
      conditions.push(eq(packageTable.private, params.private))
    }

    // Private package visibility
    if (!params.viewer?.sysadmin) {
      if (params.viewer?.userId) {
        const userOrgIds = this.db
          .select({ organizationId: userOrgMembership.organizationId })
          .from(userOrgMembership)
          .where(eq(userOrgMembership.userId, params.viewer.userId))
        conditions.push(
          or(eq(packageTable.private, false), inArray(packageTable.ownerOrg, userOrgIds))!
        )
      } else {
        conditions.push(eq(packageTable.private, false))
      }
    }

    return conditions
  }

  async list(params: PaginationParams & PackageFilterParams) {
    const { offset = 0, limit = 20 } = params

    const conditions = await this.buildConditions(params)
    if (conditions === null) {
      return { items: [], total: 0, offset, limit } as PaginatedResult<never>
    }

    const where = and(...conditions)

    const rows = await this.db
      .select({
        ...getTableColumns(packageTable),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
        formats:
          sql<string>`(SELECT COALESCE(string_agg(DISTINCT "resource"."format", ',' ORDER BY "resource"."format"), '') FROM "resource" WHERE "resource"."package_id" = "package"."id" AND "resource"."state" = 'active')`.as(
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
      })
      .from(packageTable)
      .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
      .where(where)
      .orderBy(desc(packageTable.updated))
      .limit(limit)
      .offset(offset)

    const total = rows[0]?.total ?? 0

    // Batch fetch matched resources when text query is present
    let matchedByPackage: ReturnType<typeof groupMatchedResources> = {}
    if (params.q) {
      const packageIds = rows.map((r) => r.id)
      if (packageIds.length > 0) {
        const pattern = `%${escapeLike(params.q)}%`
        const matchedRows = await this.db
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

        matchedByPackage = groupMatchedResources(matchedRows)
      }
    }

    const items = rows.map(({ total: _, ...rest }) => ({
      ...rest,
      ...(matchedByPackage[rest.id] && { matchedResources: matchedByPackage[rest.id] }),
    }))

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  /**
   * Get facet counts for each filter dimension.
   * Each dimension excludes its own filter to allow switching.
   */
  async getFacets(params: PackageFilterParams): Promise<FacetCounts> {
    const [organizations, groups, tags, formats, licenses] = await Promise.all([
      this.getOrgFacet(params),
      this.getGroupFacet(params),
      this.getTagFacet(params),
      this.getFormatFacet(params),
      this.getLicenseFacet(params),
    ])
    return { organizations, groups, tags, formats, licenses }
  }

  private async getOrgFacet(params: PackageFilterParams): Promise<FacetItem[]> {
    const conditions = await this.buildConditions(params, 'owner_org')

    // If other filters are unresolvable, return all orgs with count=0
    if (conditions === null) {
      const allOrgs = await this.db
        .select({ name: organization.name, title: organization.title })
        .from(organization)
        .where(eq(organization.state, 'active'))
        .orderBy(organization.title)
      return allOrgs.map((o) => ({ name: o.name, title: o.title, count: 0 }))
    }

    const filteredCounts = this.db
      .select({
        ownerOrg: packageTable.ownerOrg,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(packageTable)
      .where(and(...conditions))
      .groupBy(packageTable.ownerOrg)
      .as('fc')

    const rows = await this.db
      .select({
        name: organization.name,
        title: organization.title,
        count: sql<number>`COALESCE(${filteredCounts.count}, 0)`.as('count'),
      })
      .from(organization)
      .leftJoin(filteredCounts, eq(organization.id, filteredCounts.ownerOrg))
      .where(eq(organization.state, 'active'))
      .orderBy(organization.title)

    return rows.map((r) => ({ name: r.name, title: r.title, count: r.count }))
  }

  private async getGroupFacet(params: PackageFilterParams): Promise<FacetItem[]> {
    const conditions = await this.buildConditions(params, 'group')

    if (conditions === null) {
      const allGroups = await this.db
        .select({ name: group.name, title: group.title })
        .from(group)
        .where(eq(group.state, 'active'))
        .orderBy(group.title)
      return allGroups.map((g) => ({ name: g.name, title: g.title, count: 0 }))
    }

    const filteredCounts = this.db
      .select({
        groupId: packageGroup.groupId,
        count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
      })
      .from(packageTable)
      .innerJoin(packageGroup, eq(packageGroup.packageId, packageTable.id))
      .where(and(...conditions))
      .groupBy(packageGroup.groupId)
      .as('fc')

    const rows = await this.db
      .select({
        name: group.name,
        title: group.title,
        count: sql<number>`COALESCE(${filteredCounts.count}, 0)`.as('count'),
      })
      .from(group)
      .leftJoin(filteredCounts, eq(group.id, filteredCounts.groupId))
      .where(eq(group.state, 'active'))
      .orderBy(group.title)

    return rows.map((r) => ({ name: r.name, title: r.title, count: r.count }))
  }

  private async getTagFacet(params: PackageFilterParams): Promise<FacetItem[]> {
    const conditions = await this.buildConditions(params, 'tags')

    if (conditions === null) {
      const allTags = await this.db
        .select({ name: tag.name })
        .from(tag)
        .where(sql`${tag.vocabularyId} IS NULL`)
        .orderBy(tag.name)
      return allTags.map((t) => ({ name: t.name, count: 0 }))
    }

    const filteredCounts = this.db
      .select({
        tagId: packageTag.tagId,
        count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
      })
      .from(packageTable)
      .innerJoin(packageTag, eq(packageTag.packageId, packageTable.id))
      .where(and(...conditions))
      .groupBy(packageTag.tagId)
      .as('fc')

    const rows = await this.db
      .select({
        name: tag.name,
        count: sql<number>`COALESCE(${filteredCounts.count}, 0)`.as('count'),
      })
      .from(tag)
      .leftJoin(filteredCounts, eq(tag.id, filteredCounts.tagId))
      .where(sql`${tag.vocabularyId} IS NULL`)
      .orderBy(tag.name)

    return rows.map((r) => ({ name: r.name, count: r.count }))
  }

  private async getFormatFacet(params: PackageFilterParams): Promise<FacetItem[]> {
    const conditions = await this.buildConditions(params, 'formats')

    if (conditions === null) {
      const allFormats = await this.db
        .selectDistinct({ format: resource.format })
        .from(resource)
        .where(
          and(
            eq(resource.state, 'active'),
            sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
          )
        )
        .orderBy(resource.format)
      return allFormats
        .map((r) => r.format!)
        .filter(Boolean)
        .map((f) => ({ name: f.toUpperCase(), count: 0 }))
    }

    const filteredCounts = this.db
      .select({
        fmt: sql<string>`UPPER(${resource.format})`.as('fmt'),
        count: sql<number>`COUNT(DISTINCT ${packageTable.id})::int`.as('count'),
      })
      .from(packageTable)
      .innerJoin(
        resource,
        and(eq(resource.packageId, packageTable.id), eq(resource.state, 'active'))
      )
      .where(and(...conditions, sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`))
      .groupBy(sql`UPPER(${resource.format})`)
      .as('fc')

    const allFormats = this.db
      .selectDistinct({
        format: sql<string>`UPPER(${resource.format})`.as('format'),
      })
      .from(resource)
      .where(
        and(
          eq(resource.state, 'active'),
          sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
        )
      )
      .as('af')

    const rows = await this.db
      .select({
        name: allFormats.format,
        count: sql<number>`COALESCE(${filteredCounts.count}, 0)`.as('count'),
      })
      .from(allFormats)
      .leftJoin(filteredCounts, eq(allFormats.format, filteredCounts.fmt))
      .orderBy(allFormats.format)

    return rows.map((r) => ({ name: r.name, count: r.count }))
  }

  private async getLicenseFacet(params: PackageFilterParams): Promise<FacetItem[]> {
    const conditions = await this.buildConditions(params, 'license_id')

    if (conditions === null) {
      const allLicenses = await this.db
        .selectDistinct({ licenseId: packageTable.licenseId })
        .from(packageTable)
        .where(
          and(
            eq(packageTable.state, 'active'),
            sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`
          )
        )
        .orderBy(packageTable.licenseId)
      return allLicenses
        .map((r) => r.licenseId!)
        .filter(Boolean)
        .map((l) => ({ name: l, count: 0 }))
    }

    const filteredCounts = this.db
      .select({
        licenseId: packageTable.licenseId,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(packageTable)
      .where(
        and(
          ...conditions,
          sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`
        )
      )
      .groupBy(packageTable.licenseId)
      .as('fc')

    const allLicenses = this.db
      .selectDistinct({ licenseId: packageTable.licenseId })
      .from(packageTable)
      .where(
        and(
          eq(packageTable.state, 'active'),
          sql`${packageTable.licenseId} IS NOT NULL AND ${packageTable.licenseId} != ''`
        )
      )
      .as('al')

    const rows = await this.db
      .select({
        name: allLicenses.licenseId,
        count: sql<number>`COALESCE(${filteredCounts.count}, 0)`.as('count'),
      })
      .from(allLicenses)
      .leftJoin(filteredCounts, eq(allLicenses.licenseId, filteredCounts.licenseId))
      .orderBy(allLicenses.licenseId)

    return rows.map((r) => ({ name: r.name!, count: r.count }))
  }

  async getByNameOrId(nameOrId: string) {
    const [result] = await this.db
      .select()
      .from(packageTable)
      .where(
        and(
          isUuid(nameOrId) ? eq(packageTable.id, nameOrId) : eq(packageTable.name, nameOrId),
          eq(packageTable.state, 'active')
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
  async getByNameOrIdWithAccessCheck(nameOrId: string, viewer?: ViewerContext) {
    const pkg = await this.getByNameOrId(nameOrId)

    if (pkg.private && !viewer?.sysadmin) {
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

  async getDetailByNameOrId(nameOrId: string, viewer?: ViewerContext) {
    const pkg = await this.getByNameOrIdWithAccessCheck(nameOrId, viewer)

    const [resources, tags, groups, org] = await Promise.all([
      this.db
        .select()
        .from(resource)
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
}
