/**
 * KUKAN Package Service
 * Business logic for package (dataset) management
 */

import { eq, ilike, and, or, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, tag, packageTag, organization } from '@kukan/db'
import { NotFoundError, ValidationError } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'
import type { CreatePackageInput, UpdatePackageInput, PatchPackageInput } from '@kukan/shared'

export class PackageService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string; owner_org?: string; private?: boolean }) {
    const { offset = 0, limit = 20, q, owner_org, private: isPrivate } = params

    const conditions = [eq(packageTable.state, 'active')]

    if (q) {
      conditions.push(
        or(
          ilike(packageTable.name, `%${q}%`),
          ilike(packageTable.title, `%${q}%`),
          ilike(packageTable.notes, `%${q}%`)
        )!
      )
    }

    if (owner_org) {
      conditions.push(eq(packageTable.ownerOrg, owner_org))
    }

    if (typeof isPrivate === 'boolean') {
      conditions.push(eq(packageTable.private, isPrivate))
    }

    const items = await this.db
      .select()
      .from(packageTable)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)

    const total = items.length // TODO: Implement proper count query

    return {
      items,
      total,
      offset,
      limit,
    } as PaginatedResult<(typeof items)[0]>
  }

  async getByNameOrId(nameOrId: string) {
    // Check if it's a UUID pattern
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)

    const [result] = await this.db
      .select()
      .from(packageTable)
      .where(
        and(
          isUuid ? eq(packageTable.id, nameOrId) : eq(packageTable.name, nameOrId),
          eq(packageTable.state, 'active')
        )
      )
      .limit(1)

    if (!result) {
      throw new NotFoundError('Package', nameOrId)
    }

    return result
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
      title: input.title ?? existing.title,
      notes: input.notes ?? existing.notes,
      url: input.url ?? existing.url,
      version: input.version ?? existing.version,
      license_id: input.license_id ?? existing.licenseId,
      author: input.author ?? existing.author,
      author_email: input.author_email ?? existing.authorEmail,
      maintainer: input.maintainer ?? existing.maintainer,
      maintainer_email: input.maintainer_email ?? existing.maintainerEmail,
      owner_org: input.owner_org ?? existing.ownerOrg,
      private: input.private ?? existing.private,
      type: input.type ?? existing.type,
      extras: input.extras ?? existing.extras,
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
