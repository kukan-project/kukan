/**
 * KUKAN Organization Service
 * Business logic for organization management
 */

import { eq, ilike, and, or, sql, getTableColumns } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { organization, userOrgMembership, user } from '@kukan/db'
import { NotFoundError, ValidationError, isUuid, escapeLike } from '@kukan/shared'
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
          ilike(organization.name, `%${escapeLike(q)}%`),
          ilike(organization.title, `%${escapeLike(q)}%`),
          ilike(organization.description, `%${escapeLike(q)}%`)
        )!
      )
    }

    const where = and(...conditions)

    const rows = await this.db
      .select({
        ...getTableColumns(organization),
        total: sql<number>`COUNT(*) OVER()::int`.as('total'),
        datasetCount:
          sql<number>`(SELECT COUNT(*)::int FROM "package" WHERE "package"."owner_org" = "organization"."id" AND "package"."state" = 'active')`.as(
            'dataset_count'
          ),
      })
      .from(organization)
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
      .from(organization)
      .where(
        and(
          isUuid(nameOrId) ? eq(organization.id, nameOrId) : eq(organization.name, nameOrId),
          eq(organization.state, 'active')
        )
      )
      .limit(1)

    if (!result) {
      throw new NotFoundError('Organization', nameOrId)
    }

    return result
  }

  async create(input: CreateOrganizationInput) {
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

  // ── Member management ──

  async listMembers(orgId: string) {
    const rows = await this.db
      .select({
        id: userOrgMembership.id,
        userId: userOrgMembership.userId,
        role: userOrgMembership.role,
        created: userOrgMembership.created,
        userName: user.name,
        email: user.email,
        displayName: user.displayName,
      })
      .from(userOrgMembership)
      .innerJoin(user, eq(userOrgMembership.userId, user.id))
      .where(eq(userOrgMembership.organizationId, orgId))

    return rows
  }

  async addMember(orgId: string, userId: string, role: string = 'member') {
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
      .select({ id: userOrgMembership.id })
      .from(userOrgMembership)
      .where(and(eq(userOrgMembership.userId, userId), eq(userOrgMembership.organizationId, orgId)))
      .limit(1)

    if (existing) {
      // Update role if already a member
      const [updated] = await this.db
        .update(userOrgMembership)
        .set({ role })
        .where(eq(userOrgMembership.id, existing.id))
        .returning()
      return updated
    }

    const [created] = await this.db
      .insert(userOrgMembership)
      .values({
        userId,
        organizationId: orgId,
        role,
      })
      .returning()

    return created
  }

  async removeMember(orgId: string, userId: string) {
    const [deleted] = await this.db
      .delete(userOrgMembership)
      .where(and(eq(userOrgMembership.userId, userId), eq(userOrgMembership.organizationId, orgId)))
      .returning()

    if (!deleted) {
      throw new NotFoundError('Membership', `user=${userId} org=${orgId}`)
    }

    return { success: true }
  }
}
