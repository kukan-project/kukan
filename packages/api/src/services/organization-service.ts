/**
 * KUKAN Organization Service
 * Business logic for organization management
 */

import { eq, ilike, and, or, sql, inArray, getTableColumns } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { organization, userOrgMembership, user, packageTable } from '@kukan/db'
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  isUuid,
  escapeLike,
  PURGE_ORG_JOB_TYPE,
} from '@kukan/shared'
import type {
  PaginationParams,
  PaginatedResult,
  CreateOrganizationInput,
  UpdateOrganizationInput,
} from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { purgePackageExternals } from './package-cleanup'
import { deleteOrphanFreeTags } from './tag-service'

/** Concurrency cap for per-package external cleanup during an org purge — keeps
 *  OpenSearch/S3 from being hammered while still finishing a large org promptly. */
const EXTERNALS_CLEANUP_CONCURRENCY = 8

export class OrganizationService {
  constructor(private db: Database) {}

  async list(params: PaginationParams & { q?: string; state?: 'active' | 'deleted' }) {
    const { offset = 0, limit = 20, q, state = 'active' } = params

    const conditions = [eq(organization.state, state)]

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
        deletedDatasetCount:
          sql<number>`(SELECT COUNT(*)::int FROM "package" WHERE "package"."owner_org" = "organization"."id" AND "package"."state" = 'deleted')`.as(
            'deleted_dataset_count'
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

  async getByNameOrId(nameOrId: string, state: 'active' | 'deleted' = 'active') {
    const base = this.db
      .select()
      .from(organization)
      .where(
        and(
          isUuid(nameOrId)
            ? or(eq(organization.id, nameOrId), eq(organization.name, nameOrId))
            : eq(organization.name, nameOrId),
          eq(organization.state, state)
        )
      )
    const [result] = isUuid(nameOrId)
      ? await base
          .orderBy(sql`CASE WHEN ${organization.id} = ${nameOrId} THEN 0 ELSE 1 END`)
          .limit(1)
      : await base.limit(1)

    if (!result) {
      throw new NotFoundError('Organization', nameOrId)
    }

    return result
  }

  /**
   * Count active packages linked to an organization. This is the soft-delete /
   * purge precondition (both reject while active packages remain), so the UI can
   * proactively disable the delete action instead of relying on a failed request.
   */
  async countActivePackages(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(packageTable)
      .where(and(eq(packageTable.ownerOrg, orgId), eq(packageTable.state, 'active')))

    return row?.count ?? 0
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
        extras: input.extras,
        state: 'active',
      })
      .returning()

    return created
  }

  async update(nameOrId: string, input: UpdateOrganizationInput) {
    const existing = await this.getByNameOrId(nameOrId)

    const [updated] = await this.db
      .update(organization)
      .set({
        name: input.name,
        title: input.title ?? null,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        extras: input.extras,
        updated: new Date(),
      })
      .where(eq(organization.id, existing.id))
      .returning()

    return updated
  }

  /** Throws ConflictError if packages are still linked. Accepts the db or a tx. */
  private async assertNoLinkedPackages(
    db: Pick<Database, 'select'>,
    orgId: string,
    { activeOnly, message }: { activeOnly: boolean; message: string }
  ) {
    const conditions = [eq(packageTable.ownerOrg, orgId)]
    if (activeOnly) conditions.push(eq(packageTable.state, 'active'))

    const [linkedPkg] = await db
      .select({ id: packageTable.id })
      .from(packageTable)
      .where(and(...conditions))
      .limit(1)

    if (linkedPkg) throw new ConflictError(message)
  }

  /** Soft-delete an organization. Rejects if active packages are still linked. */
  async delete(nameOrId: string) {
    const existing = await this.getByNameOrId(nameOrId)

    await this.db.transaction(async (tx) => {
      await this.assertNoLinkedPackages(tx, existing.id, {
        activeOnly: true,
        message: 'Organization has active packages. Delete or reassign them first.',
      })

      await tx
        .update(organization)
        .set({ state: 'deleted', updated: new Date() })
        .where(eq(organization.id, existing.id))
    })

    return { success: true }
  }

  /**
   * Validate the precondition and enqueue an async purge (see {@link purgeDeletedOrg}).
   * Nothing is deleted here, so a failed enqueue leaves the org intact for retry —
   * unlike a delete-then-enqueue, which could orphan externals behind a deleted org.
   */
  async requestPurge(id: string, deps: { queue: QueueAdapter }): Promise<void> {
    await this.assertNoLinkedPackages(this.db, id, {
      activeOnly: true,
      message: 'Organization has active packages. Delete or reassign them first.',
    })
    await deps.queue.enqueue(PURGE_ORG_JOB_TYPE, { organizationId: id })
  }

  /**
   * Worker entry point: permanently erase a soft-deleted organization — externals
   * (search + storage) first, then DB rows.
   *
   * Concurrency-safe via a durable claim: the org is atomically moved 'deleted' →
   * 'purging' BEFORE any external file is touched. While 'purging' it can't be
   * restored ({@link restore} only un-deletes from 'deleted') and no package can be
   * created under it (creation requires an active org), so the package set is frozen
   * and a restore-mid-purge can't resurrect an org whose files are already gone.
   *
   * Idempotent and safe to retry (SQS redelivery): the claim re-claims its own
   * 'purging' org, an already-purged/active org is a no-op, and the destructive DB
   * delete only runs after every package's external cleanup succeeds — a failure
   * throws first, leaving the org 'purging' for a clean retry.
   */
  async purgeDeletedOrg(
    id: string,
    deps: { search?: SearchAdapter; storage: StorageAdapter }
  ): Promise<{ purged: boolean; packageCount: number }> {
    const [claimed] = await this.db
      .update(organization)
      .set({ state: 'purging', updated: new Date() })
      .where(and(eq(organization.id, id), inArray(organization.state, ['deleted', 'purging'])))
      .returning({ id: organization.id })

    // Restored, already purged, or never deleted — nothing to do.
    if (!claimed) return { purged: false, packageCount: 0 }

    const pkgs = await this.db
      .select({ id: packageTable.id })
      .from(packageTable)
      .where(eq(packageTable.ownerOrg, id))
    const packageIds = pkgs.map((p) => p.id)

    // Bounded concurrency; Promise.all (not allSettled) so a single failure throws
    // and skips the DB delete below, leaving the org 'purging' for a retry.
    for (let i = 0; i < packageIds.length; i += EXTERNALS_CLEANUP_CONCURRENCY) {
      const chunk = packageIds.slice(i, i + EXTERNALS_CLEANUP_CONCURRENCY)
      await Promise.all(
        chunk.map((pkgId) => purgePackageExternals(pkgId, deps.search, deps.storage))
      )
    }

    await this.db.transaction(async (tx) => {
      if (packageIds.length > 0) {
        await tx.delete(packageTable).where(eq(packageTable.ownerOrg, id))
        await deleteOrphanFreeTags(tx)
      }
      await tx.delete(organization).where(eq(organization.id, id))
    })

    return { purged: true, packageCount: packageIds.length }
  }

  /**
   * Restore a soft-deleted organization back to active. Only un-deletes from
   * 'deleted': an org claimed by an in-flight purge ('purging') must NOT be
   * restorable, since its external files may already be gone.
   */
  async restore(id: string) {
    const [restored] = await this.db
      .update(organization)
      .set({ state: 'active', updated: new Date() })
      .where(and(eq(organization.id, id), eq(organization.state, 'deleted')))
      .returning()

    if (!restored) throw new NotFoundError('Organization', id)
    return restored
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
