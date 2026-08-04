/**
 * KUKAN Group Service
 * Business logic for group management
 */

import { eq, ilike, and, or, sql, asc, desc, getTableColumns } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { group, userGroupMembership, user } from '@kukan/db'
import { NotFoundError, ValidationError, isUuid, escapeLike } from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  CreateGroupInput,
  UpdateGroupInput,
} from '@kukan/shared'

export class GroupService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string; orderBy?: 'name' | 'datasetCount' }) {
    const { offset = 0, limit = 20, q, orderBy } = params

    const conditions = [eq(group.state, 'active')]

    if (q) {
      conditions.push(
        or(
          ilike(group.name, `%${escapeLike(q)}%`),
          ilike(group.title, `%${escapeLike(q)}%`),
          ilike(group.description, `%${escapeLike(q)}%`)
        )!
      )
    }

    const where = and(...conditions)

    // Active packages only — draft/deleted links must not inflate the count (ADR-039)
    const datasetCount =
      sql<number>`(SELECT COUNT(*)::int FROM "package_group" JOIN "package" ON "package"."id" = "package_group"."package_id" AND "package"."state" = 'active' WHERE "package_group"."group_id" = "group"."id")`.as(
        'dataset_count'
      )

    // Ordered before LIMIT: by usage for the suggest candidates (a capped
    // fetch keeps the most-used groups), by URL identifier as the default
    // and the tiebreak
    const rows = await this.db
      .select({
        ...getTableColumns(group),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
        datasetCount,
      })
      .from(group)
      .where(where)
      .orderBy(...(orderBy === 'datasetCount' ? [desc(datasetCount)] : []), asc(group.name))
      .limit(limit)
      .offset(offset)

    const total = rows[0]?.total ?? 0
    const items = rows.map(({ total: _, ...rest }) => rest)

    return { items, total, offset, limit } as PaginatedResult<(typeof items)[0]>
  }

  async getByNameOrId(nameOrId: string, state: 'active' | 'deleted' = 'active') {
    const base = this.db
      .select()
      .from(group)
      .where(
        and(
          isUuid(nameOrId)
            ? or(eq(group.id, nameOrId), eq(group.name, nameOrId))
            : eq(group.name, nameOrId),
          eq(group.state, state)
        )
      )
    const [result] = isUuid(nameOrId)
      ? await base.orderBy(sql`CASE WHEN ${group.id} = ${nameOrId} THEN 0 ELSE 1 END`).limit(1)
      : await base.limit(1)

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
        extras: input.extras,
        state: 'active',
      })
      .returning()

    return created
  }

  async update(nameOrId: string, input: UpdateGroupInput) {
    const existing = await this.getByNameOrId(nameOrId)

    const [updated] = await this.db
      .update(group)
      .set({
        name: input.name,
        title: input.title ?? null,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
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

  /** Hard-delete a soft-deleted group and all related data (CASCADE). */
  async purge(id: string) {
    const [purged] = await this.db.delete(group).where(eq(group.id, id)).returning()

    if (!purged) throw new NotFoundError('Group', id)
    return purged
  }

  /** Restore a soft-deleted group back to active state. */
  async restore(id: string) {
    const [restored] = await this.db
      .update(group)
      .set({ state: 'active', updated: new Date() })
      .where(eq(group.id, id))
      .returning()

    if (!restored) throw new NotFoundError('Group', id)
    return restored
  }

  // ── Member management ──

  async listMembers(groupId: string) {
    const rows = await this.db
      .select({
        id: userGroupMembership.id,
        userId: userGroupMembership.userId,
        role: userGroupMembership.role,
        created: userGroupMembership.created,
        userName: user.name,
        email: user.email,
        displayName: user.displayName,
      })
      .from(userGroupMembership)
      .innerJoin(user, eq(userGroupMembership.userId, user.id))
      .where(eq(userGroupMembership.groupId, groupId))

    return rows
  }

  async addMember(groupId: string, userId: string, role: string = 'member') {
    // Verify user exists
    const [existingUser] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)

    if (!existingUser) {
      throw new NotFoundError('User', userId)
    }

    // Check if already a member
    const [existing] = await this.db
      .select({ id: userGroupMembership.id })
      .from(userGroupMembership)
      .where(and(eq(userGroupMembership.userId, userId), eq(userGroupMembership.groupId, groupId)))
      .limit(1)

    if (existing) {
      // Update role if already a member
      const [updated] = await this.db
        .update(userGroupMembership)
        .set({ role })
        .where(eq(userGroupMembership.id, existing.id))
        .returning()
      return updated
    }

    const [created] = await this.db
      .insert(userGroupMembership)
      .values({
        userId,
        groupId,
        role,
      })
      .returning()

    return created
  }

  async removeMember(groupId: string, userId: string) {
    const [deleted] = await this.db
      .delete(userGroupMembership)
      .where(and(eq(userGroupMembership.userId, userId), eq(userGroupMembership.groupId, groupId)))
      .returning()

    if (!deleted) {
      throw new NotFoundError('Membership', `user=${userId} group=${groupId}`)
    }

    return { success: true }
  }
}
