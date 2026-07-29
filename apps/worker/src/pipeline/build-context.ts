/**
 * Build PipelineContext from adapters and database.
 */

import { eq, and, sql, desc } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, packageTable } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter, ContentDoc } from '@kukan/search-adapter'
import type { IngestResult, LakeConfig } from '@kukan/lake'
import { withLakeSession } from '@kukan/lake'
import { ingestVersionIntoLake, withLakeIngestLock } from '@kukan/api/services/lake-ingest'
import { publishLiveContent } from '@kukan/api/services/storage-pointer'
import type { PackageDbState } from '@kukan/shared'
import { getVersionKey, versionOrigin } from '@kukan/shared'
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
          storageKey: resource.storageKey,
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

    async publishContent(id, content): Promise<boolean> {
      return publishLiveContent(db, id, content)
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
      // Merges with jsonb_concat, and parks the text head the merge replaces —
      // the one pointer that lives inside metadata rather than in a column of
      // its own (ADR-043). Reached when Extract threw and so left the previous
      // metadata in place; a successful Extract has already parked it.
      await db.execute(sql`
        WITH before AS (
          SELECT id, metadata ->> 'textHeadKey' AS text_head
          FROM resource_pipeline WHERE id = ${pipelineId}::uuid FOR UPDATE
        ),
        merged AS (
          UPDATE resource_pipeline p
          SET metadata = COALESCE(p.metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb,
              updated = NOW()
          FROM before b
          WHERE p.id = b.id
          RETURNING b.text_head AS previous_key, p.metadata ->> 'textHeadKey' AS new_key
        )
        INSERT INTO orphaned_object (key)
        SELECT previous_key FROM merged
        WHERE previous_key IS NOT NULL AND previous_key IS DISTINCT FROM new_key
        ON CONFLICT (key) DO NOTHING
      `)
    },

    async captureVersion({
      resourceId,
      packageId,
      currentStorageKey,
      contentHash,
      contentSize,
      schema,
    }) {
      // Unserialized: the run holds the resource's claim (ADR-044), so nothing
      // else is choosing a version number for it. The pointer comparison below
      // is what remains — it catches the one case the claim does not, a run
      // that was taken over for being stale and is still alive.
      const [res] = await db
        .select({ urlType: resource.urlType, storageKey: resource.storageKey })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1)

      const [maxRow] = await db
        .select({ version: resourceVersion.version })
        .from(resourceVersion)
        .where(eq(resourceVersion.resourceId, resourceId))
        .orderBy(desc(resourceVersion.version))
        .limit(1)
      const [activeRow] = await db
        .select({ hash: resourceVersion.hash })
        .from(resourceVersion)
        .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.state, 'active')))
        .orderBy(desc(resourceVersion.version))
        .limit(1)

      // Gated on this run's own measurement, not the row's: the row describes
      // whichever run published last, while the copy below takes the object
      // this run wrote and no one rewrites. The pointer comparison is what
      // establishes that this run is still the one describing the resource.
      const decision = decideVersionCapture({
        hash: contentHash,
        publishedKey: currentStorageKey,
        currentKey: res?.storageKey ?? null,
        maxVersion: maxRow?.version ?? null,
        latestActiveHash: activeRow?.hash ?? null,
      })
      if (!decision.captured) return decision

      const { version } = decision
      const versionKey = getVersionKey(packageId, resourceId, version)
      await storage.copy(currentStorageKey, versionKey)

      await db.insert(resourceVersion).values({
        resourceId,
        version,
        storageKey: versionKey,
        size: contentSize,
        hash: contentHash,
        origin: versionOrigin(res!.urlType),
        schema,
      })
      return { captured: true as const, version }
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
