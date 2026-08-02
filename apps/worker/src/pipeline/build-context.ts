/**
 * Build PipelineContext from adapters and database.
 */

import { randomUUID } from 'node:crypto'
import { eq, and, sql, desc } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, packageTable } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter, ContentDoc } from '@kukan/search-adapter'
import type { IngestResult, LakeConfig } from '@kukan/lake'
import { withLakeSession } from '@kukan/lake'
import { ingestVersionIntoLake, withLakeIngestLock } from '@kukan/api/services/lake-ingest'
import {
  insertVersionIfHeld,
  setVersionSchemaIfHeld,
} from '@kukan/api/services/resource-version-service'
import { copyObject, publishLiveContent, reserveObject } from '@kukan/api/services/storage-pointer'
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

    async putObject(key, body, meta) {
      // Recorded before the write, so an object created by a run that then dies
      // is still reachable — nothing else would ever name it (ADR-045).
      await reserveObject(db, key)
      await storage.upload(key, body, meta)
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

    async captureVersion({
      resourceId,
      packageId,
      currentStorageKey,
      contentHash,
      contentSize,
      claim,
    }) {
      // Unserialized: the run holds the resource's claim (ADR-044), so nothing
      // else is choosing a version number for it. The pointer comparison below
      // is what remains — it catches the one case the claim does not, a run
      // that was taken over for being stale and is still alive.
      const [res] = await db
        .select({
          urlType: resource.urlType,
          storageKey: resource.storageKey,
          format: resource.format,
        })
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
        .select({ hash: resourceVersion.hash, format: resourceVersion.format })
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
        // The insert reads the label again for itself, so an edit landing in
        // between can make the two differ. Harmless either way: the row records
        // the newer label, which is the one to compare against next time, and a
        // run this gate skips is re-enqueued by the edit that skipped it.
        format: res?.format ?? null,
        publishedKey: currentStorageKey,
        currentKey: res?.storageKey ?? null,
        maxVersion: maxRow?.version ?? null,
        latestActiveHash: activeRow?.hash ?? null,
        latestActiveFormat: activeRow?.format ?? null,
      })
      if (!decision.captured) return decision

      const { version } = decision
      const versionKey = getVersionKey(packageId, resourceId, version, randomUUID())
      await copyObject(db, storage, currentStorageKey, versionKey)

      // Under the claim, so a run that was stopped mid-capture does not leave
      // the resource a version its own step never got to report (ADR-044 §4).
      const inserted = await insertVersionIfHeld(db, claim, {
        resourceId,
        version,
        storageKey: versionKey,
        size: contentSize,
        hash: contentHash,
        origin: versionOrigin(res!.urlType),
        // The version is settled from its bytes; Interpret fills this in once it
        // has read the file this row names (ADR-046).
        schema: null,
      })
      if (!inserted) return { captured: false as const }
      return { captured: true as const, version }
    },

    async versionForContent(resourceId: string, contentHash: string) {
      const [row] = await db
        .select({
          version: resourceVersion.version,
          storageKey: resourceVersion.storageKey,
          size: resourceVersion.size,
          format: resourceVersion.format,
        })
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.resourceId, resourceId),
            eq(resourceVersion.state, 'active'),
            eq(resourceVersion.hash, contentHash)
          )
        )
        .orderBy(desc(resourceVersion.version))
        .limit(1)
      // Size is nullable on the table (pre-ADR-043 rows), but a version this
      // run can interpret was captured with the measurement Fetch took.
      return row ? { ...row, size: row.size ?? 0 } : null
    },

    async recordVersionSchema({ resourceId, version, schema, claim }) {
      await setVersionSchemaIfHeld(db, claim ?? null, { resourceId, version, schema })
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
        (session) => withLakeIngestLock(db, (tx) => ingestVersionIntoLake(tx, session, row)),
        { memoryLimitMb: LAKE_INGEST_MEMORY_LIMIT_MB, threads: LAKE_INGEST_THREADS }
      )
    },
  }
}
