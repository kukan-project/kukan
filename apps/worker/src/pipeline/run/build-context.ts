/**
 * Build PipelineContext from adapters and database.
 */

import { SystemSettingService, VOCABULARY_PACKS_KEY } from '@kukan/api/services/system-setting'
import { randomUUID } from 'node:crypto'
import { eq, and, ne, sql, desc, lt, isNotNull, isNull } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion, resourcePipeline, packageTable } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter, ContentDoc, IndexContentOptions } from '@kukan/search-adapter'
import type { IngestResult, LakeConfig } from '@kukan/lake'
import type { JobQueue } from '@kukan/queue'
import { ingestVersionIntoResourceCatalog } from '@kukan/api/services/lake/lake-catalog'
import { lakeNeedsRebuild, queueLakeRebuild } from '@kukan/api/services/lake/lake-rebuild'
import {
  parseDocumentTextKey,
  parseResourceSchema,
  parseSourceEncoding,
  parseTableProfile,
} from '@kukan/api/services/pipeline/pipeline-service'
import {
  insertVersionIfHeld,
  setVersionSchemaIfHeld,
  objectAlreadyVersioned,
  objectOwnerIsPurging,
  pendingLakeVersionSource,
} from '@kukan/api/services/resource-version-service'
import {
  copyObject,
  publishLiveContent,
  reserveObject,
} from '@kukan/api/services/pipeline/storage-pointer'
import type { PackageDbState, ResourceSchema } from '@kukan/shared'
import {
  getStorageKey,
  isDocumentFormat,
  primaryKeyOf,
  settledTypesOf,
  roleOverridesOf,
  versionOrigin,
} from '@kukan/shared'
import { decideVersionCreate } from './version-gate'
import { versionReading } from '../interpret/table/settled-types'
import { heavySection } from '@/heavy-section'
import type { PipelineContext, ResourceForPipeline } from './types'
import type { SummaryDeps } from '../steps/summarize'
import { FETCH_RATE_LIMIT_INTERVAL_S, FETCH_TURN_SPACING_S } from '@/config'

/** When a host's slot is free again, in the `fetch_rate_limit` row's terms. */
const slotFreeAt = sql`fetch_rate_limit.last_fetched_at + ${`${FETCH_RATE_LIMIT_INTERVAL_S} seconds`}::interval`

/** Displaced mid-create: the claim went, or the pointer did. */
class LostTheClaim extends Error {}

export function buildPipelineContext(
  db: Database,
  storage: StorageAdapter,
  search?: SearchAdapter,
  /**
   * DuckLake config, and the queue its writes ask for a rebuild or a clearing
   * on; omit to skip layer 2 ingest, e.g. in tests (ADR-043 Phase ii).
   */
  lake?: { config: LakeConfig; queue: Pick<JobQueue, 'enqueue'> },
  /** Omit where no abstracts are written — the step is then never started. */
  summary?: SummaryDeps | null
): PipelineContext {
  return {
    storage,
    summary: summary ?? null,
    // Read fresh on every call, past the service's cache: the run a refresh
    // queues must read the packs it was queued for (ADR-073 §決定 4), and a
    // cached read from before the change would record the old state again,
    // which nothing then queues a refresh for. One small read per table
    // interpreted. A failed read profiles without a vocabulary rather than
    // failing the interpretation — the profile then records no state, and the
    // refresh at the next start reads it again
    vocabularyPacks: () =>
      new SystemSettingService(db).getSetting(VOCABULARY_PACKS_KEY).catch(() => []),
    // Read fresh like the packs, for the rebuild an override queues. A failed
    // read profiles by the rules alone rather than failing the interpretation:
    // the override refines the profile, and a reprocess reads it again
    async roleOverrides(resourceId: string) {
      try {
        const [res] = await db
          .select({ columnSettings: resource.columnSettings })
          .from(resource)
          .where(eq(resource.id, resourceId))
          .limit(1)
        return roleOverridesOf(res?.columnSettings)
      } catch {
        return null
      }
    },

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

    async acquireFetchSlot(fqdn: string): Promise<number> {
      // Taken when the statement wrote the row. Not read off the row's time: two
      // transactions can share a `NOW()`, and the one refused would then see
      // its own time there.
      const taken = await db.execute(sql`
        INSERT INTO fetch_rate_limit (fqdn, last_fetched_at)
        VALUES (${fqdn}, NOW())
        ON CONFLICT (fqdn) DO UPDATE
          SET last_fetched_at = NOW()
          WHERE ${slotFreeAt} < NOW()
        RETURNING fqdn
      `)
      if (taken.rows.length > 0) return 0
      // Refused, which a turn's collision is and a loop is not: how long is left
      const left = await db.execute<{ wait: string }>(sql`
        SELECT extract(epoch FROM ${slotFreeAt} - NOW()) AS wait
        FROM fetch_rate_limit WHERE fqdn = ${fqdn}
      `)
      // Never 0 when refused: 0 is the answer that the slot was taken
      return Math.max(Number(left.rows[0]?.wait ?? 0), 0.1)
    },

    async reserveFetchTurn(fqdn: string): Promise<number> {
      // Free now only when the interval has passed and every turn handed out
      // has come; `greatest` skips the null of a host nobody has waited on
      const next = sql`greatest(
        fetch_rate_limit.reserved_until + ${`${FETCH_TURN_SPACING_S} seconds`}::interval,
        ${slotFreeAt},
        NOW()
      )`
      const result = await db.execute<{ wait: string }>(sql`
        INSERT INTO fetch_rate_limit (fqdn, last_fetched_at, reserved_until)
        VALUES (${fqdn}, NOW(), NOW())
        ON CONFLICT (fqdn) DO UPDATE
          SET reserved_until = ${next},
              last_fetched_at = CASE WHEN ${next} <= NOW() THEN NOW()
                ELSE fetch_rate_limit.last_fetched_at END
        RETURNING extract(epoch FROM reserved_until - NOW()) AS wait
      `)
      return Math.max(Number(result.rows[0].wait), 0)
    },

    async indexContent(doc: ContentDoc, options?: IndexContentOptions): Promise<void> {
      if (search) {
        await search.indexContent(doc, options)
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
          columnSettings: resource.columnSettings,
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
        .select({
          hash: resourceVersion.hash,
          format: resourceVersion.format,
          keyColumns: resourceVersion.lakeKeyColumns,
          settledTypes: resourceVersion.settledTypes,
        })
        .from(resourceVersion)
        .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.state, 'active')))
        .orderBy(desc(resourceVersion.version))
        .limit(1)

      // Gated on this run's own measurement, not the row's: the row describes
      // whichever run published last, while the object this run wrote is the
      // one it measured and no one rewrites. The pointer comparison is what
      // establishes that this run is still the one describing the resource.
      // Whether the version owning this object is on its way out — see the
      // gate's own note on what that means. Through the shared question, which
      // a revert asks too: both are "are these bytes about to be destroyed".
      const purgingOwner = await objectOwnerIsPurging(db, currentStorageKey)

      const decision = decideVersionCreate({
        identity: {
          hash: contentHash,
          // The insert reads the label and the key again for itself, so an edit
          // landing in between can make the two differ. Harmless either way: the
          // row records the newer reading, which is the one to compare against
          // next time, and a run this gate skips is re-enqueued by the edit that
          // skipped it.
          format: res?.format ?? null,
          keyColumns: primaryKeyOf(res?.columnSettings),
          settledTypes: settledTypesOf(res?.columnSettings?.types),
        },
        latestActive: activeRow
          ? {
              hash: activeRow.hash,
              format: activeRow.format,
              keyColumns: activeRow.keyColumns,
              settledTypes: settledTypesOf(activeRow.settledTypes),
            }
          : null,
        publishedKey: currentStorageKey,
        currentKey: res?.storageKey ?? null,
        maxVersion: maxRow?.version ?? null,
        keyOwnedByPurgingVersion: purgingOwner,
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
          settledTypes: resourceVersion.settledTypes,
          schema: resourceVersion.schema,
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
      if (!row) return null
      const { settledTypes, schema, ...version } = row
      const types = settledTypesOf(settledTypes)
      // A version read once is read again as it was — a reprocess, or one a
      // revert issued with the schema of the version it went back to — so its
      // dates and digits stay what its preview and layer 2 already show. One
      // read for the first time decides them, from the version before it.
      const reading = versionReading(
        settledTypes,
        schema,
        types && !schema ? await schemaBefore(db, resourceId, version.version) : null
      )
      // Size is nullable on the table (pre-ADR-043 rows), but a version this
      // run can interpret was created with the measurement Fetch took.
      return { ...version, size: version.size ?? 0, reading }
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
      // A preview, or a document's text, made from these bytes
      if (!row?.previewKey && !parseDocumentTextKey(metadata)) return false
      if (metadata.sourceHash !== contentHash) return false
      if (madeForAnotherVersion(metadata, version)) return false
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

    async storedInterpretation(resourceId: string, contentHash: string, version: number) {
      const [row] = await db
        .select({
          previewKey: resourcePipeline.previewKey,
          metadata: resourcePipeline.metadata,
          profile: resourcePipeline.profile,
          format: resource.format,
        })
        .from(resourcePipeline)
        .innerJoin(resource, eq(resource.id, resourcePipeline.resourceId))
        .where(eq(resourcePipeline.resourceId, resourceId))
        .limit(1)
      const metadata = (row?.metadata ?? {}) as Record<string, unknown>
      if (!row || metadata.sourceHash !== contentHash) return null
      if (madeForAnotherVersion(metadata, version)) return null
      // A text head from before `documentTextBytes` is not a text artifact
      const textKey = parseDocumentTextKey(metadata)
      const textBytes = metadata.documentTextBytes
      const documentText =
        textKey && typeof textBytes === 'number' ? { key: textKey, bytes: textBytes } : undefined
      // A document read before its text was kept — a Markdown, read as text
      // then — is indexed only once it is interpreted again
      if (isDocumentFormat(row.format) && !documentText) return null
      // A text file, or a CSV that made no table, leaves only how it was read
      const encoding = parseSourceEncoding(metadata)
      if (!row.previewKey && !documentText && !encoding) return null
      // A table read before its profile was kept (ADR-063) is indexed by one
      // only once it is interpreted again. A CSV that made no table keeps an
      // empty schema, which says it was read, and has no profile to wait for
      const profile = parseTableProfile(row.profile)
      if (parseResourceSchema(metadata)?.columns.length && !profile) return null
      return {
        previewKey: row.previewKey,
        ...(encoding && { encoding }),
        ...(profile && { profile }),
        ...(documentText && { documentText }),
      }
    },

    async recordVersionSchema({ claim, noTableReason, readingProposal, ...v }) {
      // The columns have to be cleared when a re-interpretation finds a table, so
      // the write spells "nothing" as null; callers spell it as absent.
      await setVersionSchemaIfHeld(db, claim ?? null, {
        ...v,
        noTableReason: noTableReason ?? null,
        readingProposal: readingProposal ?? null,
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
            sql`${resourceVersion.lakeSnapshotId} IS NULL`,
            // The same condition the sweep states (spec §6.6): a version the
            // ingest has refused over its key has no work outstanding, and
            // disagreeing here would run the Lake step on every pass to be
            // refused again.
            sql`${resourceVersion.lakeIngestReason} IS NULL`
          )
        )
        .orderBy(desc(resourceVersion.version))
        .limit(1)
      return row?.version ?? null
    },

    async ingestLakeVersion(row): Promise<IngestResult | null> {
      if (!lake) return null
      // Rebuilt instead, in a job of its own: a rebuild interprets every other
      // version, and this runs inside an interpretation. That job loads this
      // version with the rest and hands on from there (ADR-067 §6).
      if (await lakeNeedsRebuild(db, row.resourceId)) {
        await queueLakeRebuild(lake.queue, row.resourceId)
        return null
      }
      // Heavy like the interpretation that precedes it: the two side by side
      // would hold both DuckDB caps at once
      const result = await heavySection(() =>
        ingestVersionIntoResourceCatalog(db, { lake: lake.config, store: storage, storage }, row)
      )
      // Committed, with what earlier attempts left uncleared: the same job
      // clears it, and the queue retries that
      if (result?.uncleared) await queueLakeRebuild(lake.queue, row.resourceId)
      return result
    },
  }
}

/**
 * The schema of the newest active version below `version` that was read to a
 * table, whose formats and digits a first reading of `version` falls back on
 * (Versioning ii-c §8.3). One read to none decided nothing.
 */
async function schemaBefore(
  db: Database,
  resourceId: string,
  version: number
): Promise<ResourceSchema | null> {
  const [before] = await db
    .select({ schema: resourceVersion.schema })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        eq(resourceVersion.state, 'active'),
        lt(resourceVersion.version, version),
        isNotNull(resourceVersion.schema),
        isNull(resourceVersion.noTableReason)
      )
    )
    .orderBy(desc(resourceVersion.version))
    .limit(1)
  return before?.schema ?? null
}

/**
 * Whether the row's interpretation was made for another version than
 * `version` (ADR-046): the same bytes can be several versions, read as another
 * format or keyed another way. A row from before the version was recorded is
 * not taken to be another's.
 */
function madeForAnotherVersion(metadata: Record<string, unknown>, version: number): boolean {
  return typeof metadata.sourceVersion === 'number' && metadata.sourceVersion !== version
}
