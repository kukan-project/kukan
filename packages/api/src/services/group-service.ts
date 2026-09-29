/**
 * KUKAN Group Service
 * Business logic for group management
 */

import { eq, ilike, and, or, sql, asc, desc, count, getTableColumns, inArray } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { group, userGroupMembership, user, packageTable, packageGroup } from '@kukan/db'
import { NotFoundError, ValidationError, isUuid, escapeLike } from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  CreateGroupInput,
  UpdateGroupInput,
} from '@kukan/shared'
import { markPackageDocs } from './doc-marks'
import { groupMemberCountSql, packageVisibilitySql, type AuthUser } from '../auth/permissions'

/** Mark a group's datasets for the sync: their search documents carry its name */
async function markGroupPackages(tx: Transaction, groupId: string): Promise<void> {
  await markPackageDocs(
    tx,
    inArray(
      packageTable.id,
      tx
        .select({ id: packageGroup.packageId })
        .from(packageGroup)
        .where(eq(packageGroup.groupId, groupId))
    )
  )
}

export class GroupService {
  constructor(private db: Database) {}

  async list(
    params: PaginationParams & { q?: string; orderBy?: 'name' | 'datasetCount' },
    viewer?: AuthUser
  ) {
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

    // Active packages the viewer may see — draft/deleted links must not
    // inflate the count (ADR-039), private ones only per packageVisibilitySql
    const visibility = await packageVisibilitySql(this.db, viewer)
    const datasetCount = sql`${this.db
      .select({ count: count() })
      .from(packageGroup)
      .innerJoin(
        packageTable,
        and(
          eq(packageTable.id, packageGroup.packageId),
          eq(packageTable.state, 'active'),
          visibility
        )
      )
      .where(eq(packageGroup.groupId, group.id))}`
      .mapWith(Number)
      .as('dataset_count')

    // Ordered before LIMIT: by usage for the suggest candidates (a capped
    // fetch keeps the most-used groups), by URL identifier as the default
    // and the tiebreak
    const rows = await this.db
      .select({
        ...getTableColumns(group),
        total: sql`${count()} over ()`.mapWith(Number).as('total'),
        datasetCount,
        memberCount: groupMemberCountSql(viewer).as('member_count'),
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
      throw new ValidationError(
        'Group name already exists',
        { name: input.name },
        'group-name-taken'
      )
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

    return await this.db.transaction(async (tx) => {
      // The name the documents carry now, and the datasets marked before the
      // rename — see OrganizationService.update. Here it matters most: a
      // dataset edit relinks its groups, checking its key to this row while
      // holding its own
      const [before] = await tx
        .select({ name: group.name })
        .from(group)
        .where(eq(group.id, existing.id))
        .for('no key update')
      if (before && input.name !== before.name) await markGroupPackages(tx, existing.id)
      const [updated] = await tx
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
      // Again, now the rename holds the row whole — see OrganizationService.update
      if (before && input.name !== before.name) await markGroupPackages(tx, existing.id)
      return updated
    })
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
    return await this.db.transaction(async (tx) => {
      // Before the links go with it: the documents still name the group. As
      // for a rename, twice: once ahead of the row's full lock, against the
      // edit that relinks while holding its own row, and again once it is
      // held, for a link that committed in between — after the delete, the
      // link is gone and the dataset cannot be found
      await markGroupPackages(tx, id)
      await tx.select({ id: group.id }).from(group).where(eq(group.id, id)).for('update')
      await markGroupPackages(tx, id)
      const [purged] = await tx.delete(group).where(eq(group.id, id)).returning()

      if (!purged) throw new NotFoundError('Group', id)
      return purged
    })
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
