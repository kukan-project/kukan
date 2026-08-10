/**
 * Build PipelineContext from adapters and database.
 */

import { randomUUID } from 'node:crypto'
import { eq, and, ne, sql, desc } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, resourcePipeline, packageTable } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter, ContentDoc } from '@kukan/search-adapter'
import type { IngestResult, LakeConfig } from '@kukan/lake'
import { withLakeSession } from '@kukan/lake'
import { ingestVersionIntoLake, withLakeIngestLock } from '@kukan/api/services/lake-ingest'
import {
  insertVersionIfHeld,
  setVersionSchemaIfHeld,
  objectAlreadyVersioned,
  pendingLakeVersionSource,
} from '@kukan/api/services/resource-version-service'
import { copyObject, publishLiveContent, reserveObject } from '@kukan/api/services/storage-pointer'
import type { PackageDbState } from '@kukan/shared'
import { getStorageKey, versionOrigin } from '@kukan/shared'
import { decideVersionCreate } from './version-gate'
import type { PipelineContext, ResourceForPipeline } from './types'
import {
  FETCH_RATE_LIMIT_INTERVAL_S,
  LAKE_INGEST_MEMORY_LIMIT_MB,
  LAKE_INGEST_THREADS,
} from '@/config'

/** Displaced mid-create: the claim went, or the pointer did. */
class LostTheClaim extends Error {}

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

    async createVersion({
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
      // whichever run published last, while the object this run wrote is the
      // one it measured and no one rewrites. The pointer comparison is what
      // establishes that this run is still the one describing the resource.
      // Whether the version owning this object is on its way out — see the
      // gate's own note on what that means.
      const [purgingOwner] = await db
        .select({ id: resourceVersion.id })
        .from(resourceVersion)
        .where(
          and(
            eq(resourceVersion.storageKey, currentStorageKey),
            eq(resourceVersion.state, 'purging')
          )
        )
        .limit(1)

      const decision = decideVersionCreate({
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
        keyOwnedByPurgingVersion: purgingOwner !== undefined,
      })
      if (!decision.created) return decision

      const { version } = decision
      // What the row will say about itself either way; only the key differs.
      // The version is settled from its bytes, and Interpret fills the schema in
      // once it has read the file this row names (ADR-046).
      const row = {
        resourceId,
        version,
        size: contentSize,
        hash: contentHash,
        origin: versionOrigin(res!.urlType),
        schema: null,
      }

      // Taking is the ordinary case, and the copy it replaces was history rather
      // than necessity: nothing rewrites a live object — every writer mints a
      // key of its own and moves the pointer — so the bytes a version promises
      // are as immutable where they already lie. With no new object there is
      // nothing for a crash to strand, so the write-ahead record goes with the
      // copy (ADR-045) and this is one statement.
      if (!(await objectAlreadyVersioned(db, currentStorageKey))) {
        const inserted = await insertVersionIfHeld(db, claim, {
          ...row,
          storageKey: currentStorageKey,
        })
        return inserted ? { created: true, version } : { created: false }
      }

      // Copying is what live not moving leaves: an upload keeps its key across
      // runs, and a revert puts live back onto a version's own object, so
      // changing the interpretation of content that did not move would file a
      // second version against the first one's file. Purging either would then
      // take the other's bytes, or leave them — the outcome ADR-046 §3 refused.
      const versionKey = getStorageKey(packageId, resourceId, randomUUID())
      await copyObject(db, storage, currentStorageKey, versionKey)

      // The row and the pointer together or not at all. Everything downstream
      // reads "live names the newest active version's object" off
      // `resource.storage_key` — the purge decides what to delete from it — and
      // a row that landed while the pointer did not is exactly the state that
      // loses canonical content whichever version is purged next.
      //
      // The copy stays outside: its write-ahead record is what reclaims the
      // object if this does not commit, and a rollback would take the record
      // with it (ADR-045).
      try {
        await db.transaction(async (tx) => {
          // The gate's reading of who owns the source object is only good while
          // nothing can change it, and claiming a purge takes no pipeline claim.
          // So the owner's own row is locked and read again here: between the
          // gate and this, the version this copy came from can have been
          // claimed, and filing the copy then leaves the purge unable to
          // recognise its own content. The row rather than the resource, so this
          // takes its locks in the order everything else touching versions does.
          // Asked with the predicate the gate asked, so this reads the owner
          // rather than whichever row came first: tombstones keep their key,
          // and one picked here would report no purge in flight while the
          // owner is being taken away.
          const [owner] = await tx
            .select({ state: resourceVersion.state })
            .from(resourceVersion)
            .where(
              and(
                eq(resourceVersion.storageKey, currentStorageKey),
                ne(resourceVersion.state, 'purged')
              )
            )
            .limit(1)
            .for('update')
          if (owner?.state === 'purging') throw new LostTheClaim()

          const inserted = await insertVersionIfHeld(tx, claim, { ...row, storageKey: versionKey })
          if (!inserted) throw new LostTheClaim()
          const published = await publishLiveContent(tx, resourceId, {
            key: versionKey,
            previousKey: currentStorageKey,
            hash: contentHash,
            size: contentSize,
            // Same bytes under a new interpretation, so this is not a content
            // change: `last_modified` stays where it is.
            previousHash: contentHash,
            claim,
          })
          if (!published) throw new LostTheClaim()
        })
      } catch (err) {
        if (err instanceof LostTheClaim) return { created: false }
        throw err
      }
      return { created: true, version }
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
      // run can interpret was created with the measurement Fetch took.
      return row ? { ...row, size: row.size ?? 0 } : null
    },

    async derivativesDescribe(resourceId: string, contentHash: string, version: number) {
      const [row] = await db
        .select({
          previewKey: resourcePipeline.previewKey,
          metadata: resourcePipeline.metadata,
        })
        .from(resourcePipeline)
        .where(eq(resourcePipeline.resourceId, resourceId))
        .limit(1)
      const metadata = (row?.metadata ?? {}) as Record<string, unknown>
      if (!row?.previewKey) return false
      if (metadata.sourceHash !== contentHash) return false
      if (metadata.contentIndexed !== true) return false

      // A table interpretation whose ingest never landed is asking for the run
      // this would skip, and the sweep's own predicate is what says whether one
      // is outstanding — asked here rather than restated, so a format or size
      // this deployment does not ingest is not read as unfinished work.
      // Without a lake there is nothing outstanding: the run this skips would
      // not have ingested either (ADR-043 layer 2).
      if (!lake) return true
      return (await pendingLakeVersionSource(db, { resourceId, version })) === null
    },

    async recordVersionSchema({ claim, noTableReason, ...v }) {
      // The column has to be cleared when a re-interpretation finds a table, so
      // the write spells "nothing" as null; callers spell it as absent.
      await setVersionSchemaIfHeld(db, claim ?? null, {
        ...v,
        noTableReason: noTableReason ?? null,
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
        (session) => withLakeIngestLock(db, (tx) => ingestVersionIntoLake(tx, session, row)),
        { memoryLimitMb: LAKE_INGEST_MEMORY_LIMIT_MB, threads: LAKE_INGEST_THREADS }
      )
    },
  }
}
