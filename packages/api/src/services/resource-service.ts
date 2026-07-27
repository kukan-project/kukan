/**
 * KUKAN Resource Service
 * Business logic for resource management
 */

import { randomUUID } from 'node:crypto'
import { eq, ne, and, sql, inArray, getTableColumns } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, packageTable } from '@kukan/db'
import {
  NotFoundError,
  ValidationError,
  normalizeFormat,
  detectFormat,
  getStorageKey,
} from '@kukan/shared'
import type { CreateResourceInput, UpdateResourceInput, PackageDbState } from '@kukan/shared'
import { RESOURCE_POSITION_LOCK, lockInTransaction } from './advisory-lock'
import { hasOrgMembership, hasDraftAccess, type AuthUser } from '../auth/permissions'

// Package states whose resources are reachable — drafts hold resources before publish (ADR-039)
const RESOURCE_PARENT_STATES: PackageDbState[] = ['active', 'draft']

// Public column set — the storage pointers name objects in the bucket so the
// server can resolve content for a request; no response includes them
// (ADR-043). Projected here rather than scrubbed per route, so an endpoint
// cannot leak them by forgetting.
const {
  storageKey: _storageKey,
  pendingStorageKey: _pendingStorageKey,
  ...publicResourceColumns
} = getTableColumns(resource)

export { publicResourceColumns }

/**
 * Scrub the pointers off a row from {@link ResourceService.getByIdWithAccessCheck}
 * — the one read that must carry them, because the content endpoints resolve
 * the live object from it. Everything else is projected above.
 */
export function omitStoragePointers<T extends object>(
  row: T
): Omit<T, 'storageKey' | 'pendingStorageKey'> {
  const { storageKey: _k, pendingStorageKey: _p, ...rest } = row as T & Record<string, unknown>
  return rest as Omit<T, 'storageKey' | 'pendingStorageKey'>
}

export class ResourceService {
  constructor(private db: Database) {}

  /**
   * List resources for a specific package
   * Ordered by position
   */
  async listByPackage(packageId: string) {
    // Verify package exists
    const [pkg] = await this.db
      .select({ id: packageTable.id })
      .from(packageTable)
      .where(
        and(eq(packageTable.id, packageId), inArray(packageTable.state, RESOURCE_PARENT_STATES))
      )
      .limit(1)

    if (!pkg) {
      throw new NotFoundError('Package', packageId)
    }

    // Latest live version number per resource (ADR-043); null until first captured.
    const versionAgg = this.db
      .select({
        resourceId: resourceVersion.resourceId,
        maxVersion: sql<number>`MAX(${resourceVersion.version})`.as('max_version'),
      })
      .from(resourceVersion)
      .where(ne(resourceVersion.state, 'purged'))
      .groupBy(resourceVersion.resourceId)
      .as('version_agg')

    const resources = await this.db
      .select({
        ...publicResourceColumns,
        latestVersion: versionAgg.maxVersion,
      })
      .from(resource)
      .leftJoin(versionAgg, eq(versionAgg.resourceId, resource.id))
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
      .orderBy(resource.position)

    return resources
  }

  /**
   * Get resource by ID
   */
  async getById(id: string) {
    const [res] = await this.db
      .select()
      .from(resource)
      .where(and(eq(resource.id, id), eq(resource.state, 'active')))
      .limit(1)

    if (!res) {
      throw new NotFoundError('Resource', id)
    }

    return res
  }

  /**
   * Get resource by ID with parent package visibility check.
   * Throws NotFoundError if the parent package is private and the viewer lacks access.
   */
  async getByIdWithAccessCheck(id: string, viewer?: AuthUser) {
    const [row] = await this.db
      .select({
        resource,
        pkgState: packageTable.state,
        pkgPrivate: packageTable.private,
        pkgOwnerOrg: packageTable.ownerOrg,
        pkgCreatorUserId: packageTable.creatorUserId,
      })
      .from(resource)
      .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
      .where(
        and(
          eq(resource.id, id),
          eq(resource.state, 'active'),
          inArray(packageTable.state, RESOURCE_PARENT_STATES)
        )
      )
      .limit(1)

    if (!row) {
      throw new NotFoundError('Resource', id)
    }

    // Draft resources (incl. download/preview, ADR-017/039): draft editors only
    if (row.pkgState === 'draft') {
      const pkg = { creatorUserId: row.pkgCreatorUserId, ownerOrg: row.pkgOwnerOrg }
      if (!(await hasDraftAccess(this.db, pkg, viewer))) {
        throw new NotFoundError('Resource', id)
      }
      return row.resource
    }

    if (row.pkgPrivate && !(await hasOrgMembership(this.db, row.pkgOwnerOrg, viewer))) {
      throw new NotFoundError('Resource', id)
    }

    return row.resource
  }

  /**
   * Get distinct non-empty formats across all active resources.
   * Joins the parent package so draft-only formats never leak (ADR-039).
   */
  async getDistinctFormats(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ format: resource.format })
      .from(resource)
      .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
      .where(
        and(
          eq(resource.state, 'active'),
          eq(packageTable.state, 'active'),
          sql`${resource.format} IS NOT NULL AND ${resource.format} != ''`
        )
      )
      .orderBy(resource.format)

    return rows.map((r) => r.format!).filter(Boolean)
  }

  /**
   * Serialize per-package position writes for the whole transaction:
   * create()'s MAX + 1 assignment and reorder()'s in-place renumbering
   * race under READ COMMITTED without it
   */
  private async lockResourcePositions(tx: Pick<Database, 'execute'>, packageId: string) {
    await lockInTransaction(tx, RESOURCE_POSITION_LOCK, packageId)
  }

  /**
   * Create a new resource
   * Automatically assigns position as max(position) + 1 within the package
   */
  async create(input: CreateResourceInput) {
    return await this.db.transaction(async (tx) => {
      await this.lockResourcePositions(tx, input.packageId)

      // Verify package exists
      const [pkg] = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(
          and(
            eq(packageTable.id, input.packageId),
            inArray(packageTable.state, RESOURCE_PARENT_STATES)
          )
        )
        .limit(1)

      if (!pkg) {
        throw new NotFoundError('Package', input.packageId)
      }

      // Get max position for this package
      const [maxPos] = await tx
        .select({ maxPosition: sql<number>`COALESCE(MAX(${resource.position}), -1)` })
        .from(resource)
        .where(eq(resource.packageId, input.packageId))

      const nextPosition = (maxPos?.maxPosition ?? -1) + 1

      // Create resource
      const [newResource] = await tx
        .insert(resource)
        .values({
          packageId: input.packageId,
          url: input.url,
          urlType: input.urlType,
          name: input.name,
          description: input.description,
          format: input.format ? normalizeFormat(input.format) : undefined,
          mimetype: input.mimetype,
          position: nextPosition,
          resourceType: input.resourceType,
          state: 'active',
        })
        .returning(publicResourceColumns)

      return newResource
    })
  }

  /**
   * Update resource
   */
  async update(id: string, input: UpdateResourceInput) {
    const [updated] = await this.db
      .update(resource)
      .set({
        url: input.url ?? null,
        urlType: input.urlType ?? null,
        name: input.name ?? null,
        description: input.description ?? null,
        format: input.format ? normalizeFormat(input.format) : null,
        mimetype: input.mimetype ?? null,
        resourceType: input.resourceType ?? null,
        // size/hash/extras are absent on purpose: they are system-managed
        // (measured or produced by the pipeline) and left untouched. Writing
        // back the values read above would be a read-modify-write that reverts
        // whatever the worker or the health check recorded in between — and an
        // upload is not reprocessed on edit, so a stale hash would persist.
        updated: sql`NOW()`,
      })
      .where(eq(resource.id, id))
      .returning(publicResourceColumns)

    if (!updated) throw new NotFoundError('Resource', id)
    return updated
  }

  /**
   * Reorder resources within a package.
   * Requires the complete list of active resource IDs in the desired order.
   */
  async reorder(packageId: string, resourceIds: string[]) {
    return await this.db.transaction(async (tx) => {
      await this.lockResourcePositions(tx, packageId)

      const existing = await tx
        .select({ id: resource.id })
        .from(resource)
        .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))

      const existingIds = new Set(existing.map((r) => r.id))
      const inputIds = new Set(resourceIds)

      if (resourceIds.length !== existingIds.size || inputIds.size !== resourceIds.length) {
        throw new ValidationError(
          'resource_ids must contain all active resource IDs with no duplicates'
        )
      }
      for (const id of resourceIds) {
        if (!existingIds.has(id)) {
          throw new ValidationError(`Resource ${id} does not belong to this package`)
        }
      }

      for (let i = 0; i < resourceIds.length; i++) {
        await tx
          .update(resource)
          .set({ position: i, updated: sql`NOW()` })
          .where(eq(resource.id, resourceIds[i]))
      }

      return await tx
        .select(publicResourceColumns)
        .from(resource)
        .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
        .orderBy(resource.position)
    })
  }

  /**
   * Delete resource (soft delete)
   */
  async delete(id: string) {
    const existing = await this.getById(id)

    const [deleted] = await this.db
      .update(resource)
      .set({
        state: 'deleted',
        updated: sql`NOW()`,
      })
      .where(eq(resource.id, existing.id))
      .returning(publicResourceColumns)

    return deleted
  }

  /**
   * Prepare a resource for file upload (new or replacement).
   *
   * Returns the key the caller must upload to.
   *
   * Mints the key the new bytes go to and holds it in `pending_storage_key`
   * rather than moving the live pointer (ADR-043): until the upload actually
   * lands, the resource still has its previous content, and an upload the user
   * abandons must leave it serving — and describing — exactly that. `hash` and
   * `size` therefore keep describing the live object too.
   *
   * A key minted by an earlier call to this endpoint is parked: the client may
   * have written to it before asking for another URL, and nothing points at it
   * once this one replaces it. The key parked is the one the row actually held,
   * read under the row lock in the same statement — a value read beforehand can
   * be stale by the time the update lands, which would leave a concurrent
   * caller's key referenced by nothing and parked by no one.
   */
  async prepareForUpload(
    id: string,
    input: { filename: string; contentType: string; format?: string },
    existing?: Awaited<ReturnType<ResourceService['getById']>>
  ) {
    existing ??= await this.getById(id)
    const format =
      (input.format ? normalizeFormat(input.format) : undefined) ||
      detectFormat(input.filename) ||
      existing.format
    const pendingKey = getStorageKey(existing.packageId, id, randomUUID())
    const name = existing.name || input.filename

    const result = await this.db.execute(sql`
      WITH before AS (
        SELECT id, pending_storage_key
        FROM resource
        WHERE id = ${id}::uuid
        FOR UPDATE
      ),
      updated AS (
        UPDATE resource r
        SET url = ${input.filename}::text,
            url_type = 'upload',
            name = ${name}::text,
            format = ${format ?? null}::text,
            mimetype = ${input.contentType}::text,
            pending_storage_key = ${pendingKey}::text,
            pending_storage_key_at = NOW(),
            updated = NOW()
        FROM before b
        WHERE r.id = b.id
        RETURNING b.pending_storage_key AS previous_key
      ),
      parked AS (
        INSERT INTO orphaned_object (key)
        SELECT previous_key FROM updated
        WHERE previous_key IS NOT NULL
        ON CONFLICT (key) DO NOTHING
      )
      SELECT count(*)::int AS updated FROM updated
    `)

    if ((result.rows[0] as { updated: number } | undefined)?.updated !== 1) {
      throw new NotFoundError('Resource', id)
    }
    return pendingKey
  }

  /**
   * Publish the uploaded object as the resource's content (ADR-043).
   *
   * The pointer moves and the key it replaced is parked in one statement, so
   * the row can never name an object that is already being deleted. `hash` is
   * cleared rather than taken from the caller: the worker measures the stored
   * bytes, and version capture records what it measured.
   *
   * `expectedPendingKey` is the key the caller uploaded to. Promoting whatever
   * happens to be pending would publish a key a concurrent `prepareForUpload`
   * minted — an object nobody has written yet — and describe it with the size
   * measured from a different one.
   *
   * Returns the promoted key, or null when that key is no longer the pending
   * one: a duplicate `upload-complete`, or an upload a newer one replaced.
   * Either way the live object must not be re-parked.
   */
  async promoteUpload(
    id: string,
    expectedPendingKey: string,
    input: { size: number }
  ): Promise<string | null> {
    const result = await this.db.execute(sql`
      WITH before AS (
        SELECT id, storage_key, pending_storage_key
        FROM resource
        WHERE id = ${id}::uuid AND state = 'active'
          AND pending_storage_key = ${expectedPendingKey}::text
        FOR UPDATE
      ),
      promoted AS (
        UPDATE resource r
        SET storage_key = b.pending_storage_key,
            pending_storage_key = NULL,
            pending_storage_key_at = NULL,
            size = ${input.size}::bigint,
            hash = NULL,
            updated = NOW()
        FROM before b
        WHERE r.id = b.id
        RETURNING b.storage_key AS previous_key, b.pending_storage_key AS new_key
      ),
      parked AS (
        INSERT INTO orphaned_object (key)
        SELECT previous_key FROM promoted
        WHERE previous_key IS NOT NULL
        ON CONFLICT (key) DO NOTHING
      )
      SELECT new_key FROM promoted
    `)

    const row = result.rows[0] as { new_key: string } | undefined
    return row?.new_key ?? null
  }
}
