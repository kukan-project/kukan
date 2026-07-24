/**
 * KUKAN Resource Version Service
 * Read + purge-claim logic for immutable canonical file versions (ADR-043, layer 1).
 * Purge *execution* (file deletion, state → purged) runs in the worker via executePurge.
 */

import { eq, and, lt, desc, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, resourcePipeline, auditLog } from '@kukan/db'
import { NotFoundError, getStorageKey, getVersionKey, versionOrigin } from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { PipelineService } from './pipeline-service'

export type VersionState = 'active' | 'purging' | 'purged'
export type VersionOrigin = 'upload' | 'fetch'

/** Bounded concurrency for the one-time version backfill's storage copies. */
const BACKFILL_CONCURRENCY = 10

/** A version as exposed through the API. Purged versions are tombstones: their
 *  content-bearing fields (storageKey/hash/size/schema) are withheld. */
export interface VersionView {
  version: number
  origin: VersionOrigin
  state: VersionState
  size: number | null
  hash: string | null
  schema: ResourceSchema | null
  created: Date
  purgedAt: Date | null
  purgeReason: string | null
}

function toView(row: typeof resourceVersion.$inferSelect): VersionView {
  const purged = row.state === 'purged'
  return {
    version: row.version,
    origin: row.origin as VersionOrigin,
    state: row.state as VersionState,
    // Withhold content metadata for purged tombstones.
    size: purged ? null : row.size,
    hash: purged ? null : row.hash,
    schema: purged ? null : row.schema,
    created: row.created,
    purgedAt: row.purgedAt,
    purgeReason: row.purgeReason,
  }
}

export class ResourceVersionService {
  constructor(private db: Database) {}

  /**
   * Count active resources that have content but no version yet — the work left
   * for a one-time backfill (ADR-043). Zero means the migration is complete.
   */
  async countUnversioned(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(resource)
      .where(this.unversionedWhere())
    return row?.count ?? 0
  }

  /** Active resources that have content but no version yet — the backfill work set. */
  private unversionedWhere() {
    return and(
      eq(resource.state, 'active'),
      sql`${resource.hash} IS NOT NULL`,
      sql`NOT EXISTS (SELECT 1 FROM ${resourceVersion} rv WHERE rv.resource_id = ${resource.id})`
    )
  }

  /**
   * One-time migration: snapshot the live file of every unversioned resource as
   * v1 by server-side copy (ADR-043). No re-fetch, re-index, or re-embedding —
   * the current storage key already holds the content. Idempotent (skips
   * resources that already have a version). Runs in the worker.
   */
  async backfillVersions(deps: {
    storage: StorageAdapter
  }): Promise<{ backfilled: number; failed: number }> {
    // Fetch every unversioned resource once (small rows), then process each
    // exactly once — no re-query, so a failure isn't retried into a success.
    const rows = await this.db
      .select({
        id: resource.id,
        packageId: resource.packageId,
        urlType: resource.urlType,
        hash: resource.hash,
        size: resource.size,
        schema: sql<ResourceSchema | null>`${resourcePipeline.metadata} -> 'schema'`,
      })
      .from(resource)
      .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
      .where(this.unversionedWhere())

    let backfilled = 0
    let failed = 0
    // Per-resource copy+insert, bounded concurrency. Kept per-row (not one batched
    // INSERT) so one bad object fails only its own resource, not the whole chunk.
    for (let i = 0; i < rows.length; i += BACKFILL_CONCURRENCY) {
      const results = await Promise.allSettled(
        rows.slice(i, i + BACKFILL_CONCURRENCY).map(async (r) => {
          const versionKey = getVersionKey(r.packageId, r.id, 1)
          await deps.storage.copy(getStorageKey(r.packageId, r.id), versionKey)
          await this.db.insert(resourceVersion).values({
            resourceId: r.id,
            version: 1,
            storageKey: versionKey,
            size: r.size,
            hash: r.hash,
            origin: versionOrigin(r.urlType),
            schema: r.schema ?? null,
          })
        })
      )
      for (const res of results) {
        if (res.status === 'fulfilled') backfilled++
        else failed++
      }
    }

    return { backfilled, failed }
  }

  /** List a resource's versions, newest first. */
  async listByResource(resourceId: string): Promise<VersionView[]> {
    const rows = await this.db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, resourceId))
      .orderBy(desc(resourceVersion.version))
    return rows.map(toView)
  }

  /** Get a single version (tombstone view when purged). */
  async getVersion(resourceId: string, version: number): Promise<VersionView> {
    const row = await this.getRow(resourceId, version)
    return toView(row)
  }

  /**
   * Resolve the storage key for downloading a version's content.
   * Throws NotFoundError when the version is missing or purged (content gone).
   */
  async getDownloadTarget(
    resourceId: string,
    version: number
  ): Promise<{ storageKey: string; size: number | null }> {
    const row = await this.getRow(resourceId, version)
    if (row.state === 'purged') {
      throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    }
    return { storageKey: row.storageKey, size: row.size }
  }

  /**
   * Claim a version for purge: active → purging, recording who/why durably on the
   * row (ADR-028 pattern). Idempotent — a version already purging/purged is
   * returned unchanged and should not be re-enqueued.
   * Returns { claimed } so the route knows whether to enqueue the worker job.
   */
  async claimPurge(
    resourceId: string,
    version: number,
    userId: string,
    reason: string
  ): Promise<{ claimed: boolean; view: VersionView }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(resourceVersion)
        .where(
          and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version))
        )
        .limit(1)
        .for('update')

      if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)

      if (row.state !== 'active') {
        return { claimed: false, view: toView(row) }
      }

      const [updated] = await tx
        .update(resourceVersion)
        .set({
          state: 'purging',
          purgedBy: userId,
          purgeReason: reason,
          updated: sql`NOW()`,
        })
        .where(eq(resourceVersion.id, row.id))
        .returning()

      await tx.insert(auditLog).values({
        entityType: 'resource_version',
        entityId: row.resourceId,
        action: 'purge_request',
        userId,
        changes: { version, reason },
      })

      return { claimed: true, view: toView(updated) }
    })
  }

  /**
   * Execute a claimed purge (state must be 'purging'). Runs in the worker so it
   * retries on failure. Idempotent: a row not in 'purging' is a no-op.
   *
   * Deletes the version's stored copy. If it was the live version, rolls the
   * current key back to the previous active version (or empties the resource when
   * none remains), invalidates derivatives, and re-enqueues the pipeline to
   * regenerate preview/index from the restored content. Finally marks the row
   * 'purged' (tombstone) and writes the audit entry.
   */
  async executePurge(
    resourceId: string,
    version: number,
    deps: { storage: StorageAdapter; search?: SearchAdapter; queue: QueueAdapter }
  ): Promise<{ purged: boolean; rolledBack: boolean }> {
    const [row] = await this.db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)

    if (!row || row.state !== 'purging') {
      return { purged: false, rolledBack: false }
    }

    // Live version = no active version sits above this one.
    const [above] = await this.db
      .select({ version: resourceVersion.version })
      .from(resourceVersion)
      .where(
        and(
          eq(resourceVersion.resourceId, resourceId),
          eq(resourceVersion.state, 'active'),
          sql`${resourceVersion.version} > ${version}`
        )
      )
      .limit(1)
    const isLive = !above

    // Remove the immutable versioned copy.
    await deps.storage.delete(row.storageKey)

    let rolledBack = false
    if (isLive) {
      const [pkgRow] = await this.db
        .select({ packageId: resource.packageId })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)

      if (pkgRow) {
        const currentKey = getStorageKey(pkgRow.packageId, resourceId)

        // Previous active version to restore as the live content.
        const [prev] = await this.db
          .select()
          .from(resourceVersion)
          .where(
            and(
              eq(resourceVersion.resourceId, resourceId),
              eq(resourceVersion.state, 'active'),
              lt(resourceVersion.version, version)
            )
          )
          .orderBy(desc(resourceVersion.version))
          .limit(1)

        if (prev) {
          await deps.storage.copy(prev.storageKey, currentKey)
          await this.db
            .update(resource)
            .set({ hash: prev.hash, size: prev.size, lastModified: sql`NOW()` })
            .where(eq(resource.id, resourceId))
          rolledBack = true
        } else {
          // Nothing to roll back to — the resource is left with no live content.
          await deps.storage.delete(currentKey)
          await this.db
            .update(resource)
            .set({ hash: null, size: null, lastModified: sql`NOW()` })
            .where(eq(resource.id, resourceId))
        }

        // Invalidate derivatives so the purged content stops being served
        // immediately, before the (async) pipeline regenerates them.
        await this.invalidatePreview(resourceId, deps.storage)
        if (deps.search) await deps.search.deleteContent(resourceId)

        // Regenerate preview/index from the restored content. The Version step's
        // change gate sees the restored hash as the latest active version and
        // skips, so no spurious version is captured.
        if (rolledBack) {
          await new PipelineService(this.db, deps.queue).enqueue(resourceId)
        }
      }
    }

    await this.db
      .update(resourceVersion)
      .set({ state: 'purged', purgedAt: sql`NOW()`, updated: sql`NOW()` })
      .where(eq(resourceVersion.id, row.id))

    await this.db.insert(auditLog).values({
      entityType: 'resource_version',
      entityId: resourceId,
      action: 'purge',
      userId: row.purgedBy,
      changes: { version, reason: row.purgeReason, rolledBack },
    })

    return { purged: true, rolledBack }
  }

  /** Delete the resource's preview object and clear its pipeline previewKey. */
  private async invalidatePreview(resourceId: string, storage: StorageAdapter): Promise<void> {
    const [pipe] = await this.db
      .select({ id: resourcePipeline.id, previewKey: resourcePipeline.previewKey })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)
    if (!pipe?.previewKey) return
    await storage.delete(pipe.previewKey)
    await this.db
      .update(resourcePipeline)
      .set({ previewKey: null, updated: sql`NOW()` })
      .where(eq(resourcePipeline.id, pipe.id))
  }

  private async getRow(resourceId: string, version: number) {
    const [row] = await this.db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
      .limit(1)
    if (!row) throw new NotFoundError('Resource version', `${resourceId}/v${version}`)
    return row
  }
}
