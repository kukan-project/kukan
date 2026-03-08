/**
 * KUKAN Organization Service
 * Business logic for organization management
 */

import { eq, ilike, and, or, count } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { organization } from '@kukan/db'
import { NotFoundError, ValidationError, isUuid } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

export interface CreateOrganizationInput {
  name: string
  title?: string
  description?: string
  imageUrl?: string
  state?: string
}

export interface UpdateOrganizationInput {
  title?: string
  description?: string
  imageUrl?: string
  state?: string
}

export class OrganizationService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string }) {
    const { offset = 0, limit = 20, q } = params

    const conditions = [eq(organization.state, 'active')]

    if (q) {
      conditions.push(
        or(
          ilike(organization.name, `%${q}%`),
          ilike(organization.title, `%${q}%`),
          ilike(organization.description, `%${q}%`)
        )!
      )
    }

    const where = and(...conditions)

    const [{ total }] = await this.db.select({ total: count() }).from(organization).where(where)

    const items = await this.db.select().from(organization).where(where).limit(limit).offset(offset)

    return {
      items,
      total,
      offset,
      limit,
    } as PaginatedResult<(typeof items)[0]>
  }

  async getByNameOrId(nameOrId: string) {
    const [result] = await this.db
      .select()
      .from(organization)
      .where(
        and(
          isUuid(nameOrId)
            ? eq(organization.id, nameOrId)
            : eq(organization.name, nameOrId),
          eq(organization.state, 'active')
        )
      )
      .limit(1)

    if (!result) {
      throw new NotFoundError('Organization', nameOrId)
    }

    return result
  }

  async create(input: CreateOrganizationInput, _creatorUserId?: string) {
    // Validate name uniqueness
    const existing = await this.db
      .select()
      .from(organization)
      .where(eq(organization.name, input.name))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError('Organization name already exists', {
        name: input.name,
      })
    }

    const [created] = await this.db
      .insert(organization)
      .values({
        name: input.name,
        title: input.title,
        description: input.description,
        imageUrl: input.imageUrl,
        state: input.state || 'active',
      })
      .returning()

    return created
  }

  async update(nameOrId: string, input: UpdateOrganizationInput) {
    const existing = await this.getByNameOrId(nameOrId)

    const [updated] = await this.db
      .update(organization)
      .set({
        ...input,
        updated: new Date(),
      })
      .where(eq(organization.id, existing.id))
      .returning()

    return updated
  }

  async delete(nameOrId: string) {
    const existing = await this.getByNameOrId(nameOrId)

    await this.db
      .update(organization)
      .set({
        state: 'deleted',
        updated: new Date(),
      })
      .where(eq(organization.id, existing.id))

    return { success: true }
  }
}
