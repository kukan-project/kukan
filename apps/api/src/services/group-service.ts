/**
 * KUKAN Group Service
 * Business logic for group management
 */

import { eq, ilike, and, or } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { group } from '@kukan/db'
import { NotFoundError, ValidationError } from '@kukan/shared'
import type { PaginationParams, PaginatedResult } from '@kukan/shared'

export interface CreateGroupInput {
  name: string
  title?: string
  description?: string
  imageUrl?: string
  state?: string
  extras?: Record<string, unknown>
}

export interface UpdateGroupInput {
  title?: string
  description?: string
  imageUrl?: string
  state?: string
  extras?: Record<string, unknown>
}

export class GroupService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string }) {
    const { offset = 0, limit = 20, q } = params

    const conditions = [eq(group.state, 'active')]

    if (q) {
      conditions.push(
        or(
          ilike(group.name, `%${q}%`),
          ilike(group.title, `%${q}%`),
          ilike(group.description, `%${q}%`)
        )!
      )
    }

    const items = await this.db
      .select()
      .from(group)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)

    const total = items.length // TODO: Get actual count

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
      .from(group)
      .where(
        and(isUuid ? eq(group.id, nameOrId) : eq(group.name, nameOrId), eq(group.state, 'active'))
      )
      .limit(1)

    if (!result) {
      throw new NotFoundError('Group', nameOrId)
    }

    return result
  }

  async create(input: CreateGroupInput) {
    // Validate name uniqueness
    const existing = await this.db.select().from(group).where(eq(group.name, input.name)).limit(1)

    if (existing.length > 0) {
      throw new ValidationError('Group name already exists', {
        name: input.name,
      })
    }

    const [created] = await this.db
      .insert(group)
      .values({
        name: input.name,
        title: input.title,
        description: input.description,
        imageUrl: input.imageUrl,
        state: input.state || 'active',
        extras: input.extras,
      })
      .returning()

    return created
  }

  async update(nameOrId: string, input: UpdateGroupInput) {
    const existing = await this.getByNameOrId(nameOrId)

    const [updated] = await this.db
      .update(group)
      .set({
        title: input.title,
        description: input.description,
        imageUrl: input.imageUrl,
        state: input.state,
        extras: input.extras,
        updated: new Date(),
      })
      .where(eq(group.id, existing.id))
      .returning()

    return updated
  }

  async delete(nameOrId: string) {
    const existing = await this.getByNameOrId(nameOrId)

    await this.db
      .update(group)
      .set({
        state: 'deleted',
        updated: new Date(),
      })
      .where(eq(group.id, existing.id))

    return { success: true }
  }
}
