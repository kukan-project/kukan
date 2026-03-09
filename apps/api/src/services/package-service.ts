/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { eq, ilike, and, or, sql, getTableColumns, inArray } from 'drizzle-orm'
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
import { NotFoundError, ValidationError, isUuid, escapeLike } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'
import type { CreatePackageInput, UpdatePackageInput, PatchPackageInput } from '@kukan/shared'

interface ViewerContext {
  userId?: string
  sysadmin?: boolean
}

export class PackageService {
  constructor(private db: Database) {}

  async list(
    params: PaginationParams & {
      q?: string
      owner_org?: string
      group?: string
      creator_user_id?: string
      member_user_id?: string
      private?: boolean
      viewer?: ViewerContext
    }
  ) {
    const {
      offset = 0,
      limit = 20,
      q,
      owner_org,
      group: groupFilter,
      creator_user_id,
      member_user_id,
      private: isPrivate,
      viewer,
    } = params

    const conditions = [eq(packageTable.state, 'active')]

    if (q) {
      conditions.push(
        or(
          ilike(packageTable.name, `%${escapeLike(q)}%`),
          ilike(packageTable.title, `%${escapeLike(q)}%`),
          ilike(packageTable.notes, `%${escapeLike(q)}%`)
        )!
      )
    }

    if (owner_org) {
      if (isUuid(owner_org)) {
        conditions.push(eq(packageTable.ownerOrg, owner_org))
      } else {
        // Resolve org name to ID
        const [org] = await this.db
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.name, owner_org))
          .limit(1)
        if (org) {
          conditions.push(eq(packageTable.ownerOrg, org.id))
        } else {
          // No matching org — return empty
          return { items: [], total: 0, offset, limit } as PaginatedResult<never>
        }
      }
    }

    if (groupFilter) {
      // Resolve group name or ID, then filter via package_group
      const groupCondition = isUuid(groupFilter)
        ? eq(group.id, groupFilter)
        : eq(group.name, groupFilter)
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
        return { items: [], total: 0, offset, limit } as PaginatedResult<never>
      }
    }

    if (creator_user_id) {
      conditions.push(eq(packageTable.creatorUserId, creator_user_id))
    }

    if (member_user_id) {
      // Filter packages whose owner_org is an organization the user belongs to
      const orgIds = this.db
        .select({ organizationId: userOrgMembership.organizationId })
        .from(userOrgMembership)
        .where(eq(userOrgMembership.userId, member_user_id))
      conditions.push(inArray(packageTable.ownerOrg, orgIds))
    }

    if (typeof isPrivate === 'boolean') {
      conditions.push(eq(packageTable.private, isPrivate))
    }

    // Private package visibility: only show private packages to org members or sysadmin
    if (!viewer?.sysadmin) {
      if (viewer?.userId) {
        // Authenticated: show public + private packages from user's orgs
        const userOrgIds = this.db
          .select({ organizationId: userOrgMembership.organizationId })
          .from(userOrgMembership)
          .where(eq(userOrgMembership.userId, viewer.userId))
        conditions.push(
          or(eq(packageTable.private, false), inArray(packageTable.ownerOrg, userOrgIds))!
        )
      } else {
        // Unauthenticated: only public packages
        conditions.push(eq(packageTable.private, false))
      }
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
      })
      .from(packageTable)
      .where(where)
      .limit(limit)
      .offset(offset)

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
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

    const [resources, tags, org] = await Promise.all([
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

    return { ...pkg, resources, tags, organization: org }
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
          metadataModified: sql`NOW()`,
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
        metadataModified: sql`NOW()`,
      })
      .where(eq(packageTable.id, existing.id))
      .returning()

    return deleted
  }
}
