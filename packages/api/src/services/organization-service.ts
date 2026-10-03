/**
 * KUKAN Organization Service
 * Business logic for organization management
 */

import {
  eq,
  ilike,
  and,
  or,
  sql,
  count,
  inArray,
  notExists,
  getTableColumns,
  type SQL,
} from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { organization, userOrgMembership, user, packageTable } from '@kukan/db'
import { orderTerms } from './list-order'
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
import { jobsFor, type QueueAdapter } from '@kukan/queue-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { LakeConfig } from '@kukan/lake'
import { dropResourceTables } from '@kukan/lake'
import {
  orgDeletedDatasetCountSql,
  orgMemberCountSql,
  packageVisibilitySql,
  type AuthUser,
} from '../auth/permissions'
import { reclaimLakeStorage } from './lake-reclaim'
import { listPurgeTargets, purgePackageStorage, purgePackagesSearchDocs } from './package-cleanup'
import { markPackageDocs } from './doc-marks'
import { withResourceClaimsOrConflict } from './pipeline-claim'
import { deleteOrphanFreeTags } from './tag-service'

/** Concurrency cap for per-package external cleanup during an org purge — keeps
 *  OpenSearch/S3 from being hammered while still finishing a large org promptly. */
const EXTERNALS_CLEANUP_CONCURRENCY = 8

/**
 * An organization's active packages, counted per row of a list query,
 * restricted to what the viewer may see (packageVisibilitySql).
 * Exported because the dashboard lists the viewer's own organizations from a
 * second route (routes/users.ts), and the two counts must not drift apart.
 * The deleted-state sibling lives in permissions.ts (orgDeletedDatasetCountSql)
 * because it is membership-gated rather than visibility-restricted.
 */
export function orgPackageCount(db: Database, visibility?: SQL) {
  return db.$count(
    packageTable,
    and(eq(packageTable.ownerOrg, organization.id), eq(packageTable.state, 'active'), visibility)
  )
}

export class OrganizationService {
  constructor(private db: Database) {}

  async list(
    params: PaginationParams & {
      q?: string
      state?: 'active' | 'deleted'
      /** `datasetCount` defaults to descending, the rest to ascending */
      orderBy?: 'name' | 'title' | 'datasetCount'
      sortOrder?: 'asc' | 'desc'
      /** Only these, by name */
      names?: string[]
    },
    viewer?: AuthUser
  ) {
    const { offset = 0, limit = 20, q, state = 'active', orderBy, sortOrder, names } = params

    const conditions = [eq(organization.state, state)]
    if (names?.length) conditions.push(inArray(organization.name, names))

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

    const visibility = await packageVisibilitySql(this.db, viewer)
    const datasetCount = orgPackageCount(this.db, visibility).as('dataset_count')

    // Ordered before LIMIT: without it PostgreSQL may return rows in any order,
    // so paging could repeat or skip an organization
    const rows = await this.db
      .select({
        ...getTableColumns(organization),
        total: sql`${count()} over ()`.mapWith(Number).as('total'),
        datasetCount,
        deletedDatasetCount: orgDeletedDatasetCountSql(viewer).as('deleted_dataset_count'),
        memberCount: orgMemberCountSql(viewer).as('member_count'),
      })
      .from(organization)
      .where(where)
      .orderBy(
        ...orderTerms(orderBy, sortOrder, {
          name: organization.name,
          title: organization.title,
          datasetCount,
        })
      )
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
   * Count active packages linked to an organization, restricted to what the
   * viewer may see. This backs the soft-delete / purge precondition (both
   * reject while active packages remain), so the UI can proactively disable
   * the delete action instead of relying on a failed request — for the org
   * admins and sysadmins who can delete, the visibility-restricted count
   * equals the full count.
   */
  async countActivePackages(orgId: string, viewer?: AuthUser): Promise<number> {
    return this.db.$count(
      packageTable,
      and(
        eq(packageTable.ownerOrg, orgId),
        eq(packageTable.state, 'active'),
        await packageVisibilitySql(this.db, viewer)
      )
    )
  }

  async create(input: CreateOrganizationInput) {
    // Validate name uniqueness
    const existing = await this.db
      .select()
      .from(organization)
      .where(eq(organization.name, input.name))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError(
        'Organization name already exists',
        { name: input.name },
        'organization-name-taken'
      )
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

    return await this.db.transaction(async (tx) => {
      // The name the documents carry now, read under the row's lock: compared
      // with a read before the transaction, a rename that landed in between
      // would leave this one looking like no rename at all. No-key: a dataset
      // write checking its foreign key to the organization does not wait on it
      const [before] = await tx
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, existing.id))
        .for('no key update')
      // Its live datasets' search documents carry the name. Marked before the
      // rename takes the row's full lock, so a dataset edit holding its own row
      // while it checks its key here is never waited on from behind that lock
      if (before && input.name !== before.name) {
        await markPackageDocs(tx, eq(packageTable.ownerOrg, existing.id))
      }
      const [updated] = await tx
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
      // Again, now the rename holds the row whole: a dataset that joined since
      // the first pass took the key share its insert needs, and the update
      // waited for it to commit. One joining from here waits for this commit
      // and reads the new name
      if (before && input.name !== before.name) {
        await markPackageDocs(tx, eq(packageTable.ownerOrg, existing.id))
      }
      return updated
    })
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

    if (linkedPkg) throw new ConflictError(message, undefined, 'organization-has-active-packages')
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
   * Queue the purge again for every organization left `purging` with no job
   * behind it. The claim is the job's own, so once taken nothing else asks for
   * it: the purge route accepts only a `deleted` organization. A dead job still
   * there is left alone for the admin screen.
   */
  async queueStrandedPurges(queue: QueueAdapter): Promise<{ queued: number }> {
    const rows = await queue.transaction(this.db, async (tx) => {
      const stranded = await tx
        .select({ organizationId: organization.id })
        .from(organization)
        .where(
          and(
            eq(organization.state, 'purging'),
            notExists(
              jobsFor(
                tx,
                PURGE_ORG_JOB_TYPE,
                sql`jsonb_build_object('organizationId', ${organization.id}::text)`
              )
            )
          )
        )
        .for('update', { skipLocked: true })
      await queue.enqueueMany(PURGE_ORG_JOB_TYPE, stranded, { tx })
      return stranded
    })
    return { queued: rows.length }
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
   * Idempotent and safe to retry (a job taken again): the claim re-claims its own
   * 'purging' org, an already-purged/active org is a no-op, and the destructive DB
   * delete only runs after every package's external cleanup succeeds — a failure
   * throws first, leaving the org 'purging' for a clean retry.
   */
  async purgeDeletedOrg(
    id: string,
    deps: { search?: SearchAdapter; storage: StorageAdapter; lake?: LakeConfig }
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

    // Read while the rows still exist (deleted below): every resource, to claim
    // it, and the ingested ones, which name the DuckLake tables that go with
    // them — an empty list saves opening a lake session at all.
    const { resourceIds, lakeResourceIds } = await listPurgeTargets(this.db, packageIds)

    // Claimed for the whole erasure (ADR-044). A run in flight writes its
    // preview and version files to storage before the database hears of them,
    // so one crossing the sweep below would leave the content of a purged
    // organization in the bucket with no row that names it. Taken in one
    // statement, so hundreds of resources need no acquisition order and cannot
    // deadlock; one of them held refuses the lot and the job is redelivered,
    // which the 'purging' state was already built for.
    await withResourceClaimsOrConflict(this.db, resourceIds, async () => {
      // Bounded concurrency; Promise.all (not allSettled) so a single failure throws
      // and skips the DB delete below, leaving the org 'purging' for a retry.
      // DuckLake is left out of the per-package pass and done once below: opening
      // a lake session is expensive, and one per package would mean hundreds.
      // The search documents one chunk at a time under the sync's lock, taken
      // once per chunk: it serialises them anyway, and a caller per package
      // waiting on it would hold a pooled connection each
      for (let i = 0; i < packageIds.length; i += EXTERNALS_CLEANUP_CONCURRENCY) {
        const chunk = packageIds.slice(i, i + EXTERNALS_CLEANUP_CONCURRENCY)
        await purgePackagesSearchDocs(this.db, chunk, deps.search)
        await Promise.all(chunk.map((pkgId) => purgePackageStorage(pkgId, deps.storage)))
      }
      if (deps.lake) await dropResourceTables(deps.lake, lakeResourceIds)

      await this.db.transaction(async (tx) => {
        if (packageIds.length > 0) {
          await tx.delete(packageTable).where(eq(packageTable.ownerOrg, id))
          await deleteOrphanFreeTags(tx)
        }
        await tx.delete(organization).where(eq(organization.id, id))
      })
    })

    // After the rows are gone: dropping the tables only unreferences the
    // snapshots, and the retained set is read from the version rows the
    // cascade just deleted (ADR-043 §5). Only when this purge had tables of
    // its own — a catalog-wide sweep is a maintenance job's business.
    if (lakeResourceIds.length > 0) await reclaimLakeStorage(this.db, deps.lake)

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
