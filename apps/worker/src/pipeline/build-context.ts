/**
 * Build PipelineContext from adapters and database.
 */

import { eq, and, sql, desc } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourcePipeline, resourceVersion, packageTable } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter, ContentDoc } from '@kukan/search-adapter'
import type { IngestResult, LakeConfig } from '@kukan/lake'
import { withLakeSession } from '@kukan/lake'
import { ingestVersionIntoLake, withLakeIngestLock } from '@kukan/api/services/lake-ingest'
import { VERSION_CAPTURE_LOCK, withAdvisoryLock } from '@kukan/api/services/advisory-lock'
import type { PackageDbState } from '@kukan/shared'
import { getVersionKey, versionOrigin } from '@kukan/shared'
import { copyAndMeasure, discardCopy } from '@kukan/api/services/verified-copy'
import { decideVersionCapture } from './version-capture'
import type { PipelineContext, ResourceForPipeline } from './types'
import {
  FETCH_RATE_LIMIT_INTERVAL_S,
  LAKE_INGEST_MEMORY_LIMIT_MB,
  LAKE_INGEST_THREADS,
} from '@/config'

export function buildPipelineContext(
  db: Database,
  storage: StorageAdapter,
  search?: SearchAdapter,
  /** DuckLake config; omit to skip layer 2 ingest, e.g. in tests (ADR-043 Phase ii). */
  lake?: LakeConfig
): PipelineContext {
  return {
    storage,

    async getResource(id: string): Promise<ResourceForPipeline | null> {
      const [res] = await db
        .select({
          id: resource.id,
          packageId: resource.packageId,
          name: resource.name,
          description: resource.description,
          url: resource.url,
          urlType: resource.urlType,
          format: resource.format,
          hash: resource.hash,
          size: resource.size,
        })
        .from(resource)
        .where(and(eq(resource.id, id), eq(resource.state, 'active')))
        .limit(1)

      return res ?? null
    },

    async getPackageState(packageId: string): Promise<PackageDbState | null> {
      const [pkg] = await db
        .select({ state: packageTable.state })
        .from(packageTable)
        .where(eq(packageTable.id, packageId))
        .limit(1)

      // The state column is an unconstrained varchar; the app only writes these values
      return (pkg?.state as PackageDbState | undefined) ?? null
    },

    async beginContentReplacement(id: string): Promise<void> {
      await db.update(resource).set({ hash: null, size: null }).where(eq(resource.id, id))
    },

    async recordContent(
      id: string,
      content: { hash: string; size: number; previousHash: string | null }
    ): Promise<void> {
      // Only a genuine change is a modification: a scheduled re-fetch that finds
      // the same bytes must not look like an edit downstream.
      const changed = content.previousHash !== content.hash
      await db
        .update(resource)
        .set({
          hash: content.hash,
          size: content.size,
          ...(changed && { lastModified: sql`NOW()` }),
        })
        .where(eq(resource.id, id))
    },

    async acquireFetchSlot(fqdn: string): Promise<boolean> {
      const result = await db.execute(sql`
        INSERT INTO fetch_rate_limit (fqdn, last_fetched_at)
        VALUES (${fqdn}, NOW())
        ON CONFLICT (fqdn) DO UPDATE
          SET last_fetched_at = NOW()
          WHERE fetch_rate_limit.last_fetched_at < NOW() - ${`${FETCH_RATE_LIMIT_INTERVAL_S} seconds`}::interval
        RETURNING fqdn
      `)
      return result.rows.length > 0
    },

    async indexContent(doc: ContentDoc): Promise<void> {
      if (search) {
        await search.indexContent(doc)
      }
    },

    async deleteContent(resourceId: string): Promise<void> {
      if (search) {
        await search.deleteContent(resourceId)
      }
    },

    async updatePipelineMetadata(
      pipelineId: string,
      metadata: Record<string, unknown>
    ): Promise<void> {
      // Merge with existing metadata using jsonb_concat (||)
      await db
        .update(resourcePipeline)
        .set({
          metadata: sql`COALESCE(${resourcePipeline.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
          updated: sql`NOW()`,
        })
        .where(eq(resourcePipeline.id, pipelineId))
    },

    async captureVersion({ resourceId, packageId, currentStorageKey, schema, sourceHash }) {
      return withAdvisoryLock(db, VERSION_CAPTURE_LOCK, resourceId, async (tx) => {
        // Read under the lock, on the lock's own connection.
        const [res] = await tx
          .select({ hash: resource.hash, size: resource.size, urlType: resource.urlType })
          .from(resource)
          .where(eq(resource.id, resourceId))
          .limit(1)
        const [maxRow] = await tx
          .select({ version: resourceVersion.version })
          .from(resourceVersion)
          .where(eq(resourceVersion.resourceId, resourceId))
          .orderBy(desc(resourceVersion.version))
          .limit(1)
        const [activeRow] = await tx
          .select({ hash: resourceVersion.hash })
          .from(resourceVersion)
          .where(
            and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.state, 'active'))
          )
          .orderBy(desc(resourceVersion.version))
          .limit(1)

        const decision = decideVersionCapture({
          hash: res?.hash ?? null,
          maxVersion: maxRow?.version ?? null,
          latestActiveHash: activeRow?.hash ?? null,
        })
        if (!decision.captured) return decision

        const { version } = decision
        const versionKey = getVersionKey(packageId, resourceId, version)
        const captured = await copyAndMeasure(storage, currentStorageKey, versionKey)

        // The measured hash must match the row, and — when Extract produced a
        // schema — the bytes Extract parsed, since it read the same shared key
        // earlier in this run. Either mismatch means a concurrent run moved the
        // live key; the version is abandoned rather than recorded against
        // content or a schema it does not hold, and that run captures it.
        if (
          captured.hash !== decision.hash ||
          (sourceHash !== undefined && sourceHash !== captured.hash)
        ) {
          await discardCopy(storage, versionKey)
          return { captured: false as const }
        }

        await tx.insert(resourceVersion).values({
          resourceId,
          version,
          storageKey: versionKey,
          size: captured.size,
          hash: captured.hash,
          origin: versionOrigin(res!.urlType),
          schema,
        })
        return { captured: true as const, version }
      })
    },

    async pendingLakeVersion(resourceId: string, contentHash: string): Promise<number | null> {
      const [row] = await db
        .select({ version: resourceVersion.version })
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.resourceId, resourceId),
            eq(resourceVersion.state, 'active'),
            eq(resourceVersion.hash, contentHash),
            sql`${resourceVersion.ducklakeSnapshotId} IS NULL`
          )
        )
        .orderBy(desc(resourceVersion.version))
        .limit(1)
      return row?.version ?? null
    },

    async ingestLakeVersion(row): Promise<IngestResult | null> {
      if (!lake) return null
      // Opened outside the lock: session setup costs several round trips, and
      // the lock is catalog-wide. Bounded like the API's sessions — DuckDB
      // otherwise claims most of the container's memory and a thread per core,
      // which several concurrent ingests on a small task cannot survive.
      return withLakeSession(
        lake,
        (session) => withLakeIngestLock(db, (tx) => ingestVersionIntoLake(tx, session, lake, row)),
        { memoryLimitMb: LAKE_INGEST_MEMORY_LIMIT_MB, threads: LAKE_INGEST_THREADS }
      )
    },
  }
}
