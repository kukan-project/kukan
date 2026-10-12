/**
 * Rebuilding a resource's layer 2 from layer 1 (ADR-067 §4, §6).
 *
 * One operation behind three needs: a purge (everything but the purged
 * version), a resource with a version left behind — the migration off the
 * shared catalog among them — and the repair of a catalog whose objects are
 * gone. Each version layer 1 has for layer 2 is interpreted again
 * from its file and loaded in version order into a catalog started empty in a
 * new generation, under the key it was frozen with — so a keyed history comes
 * back as it was, and nothing of a version left out reaches the new catalog.
 *
 * Interpretation is the worker's (ADR-046, ADR-059), so the caller hands it in
 * as {@link LakeVersionReader}.
 */
import {
  and,
  asc,
  countDistinct,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Database } from '@kukan/db'
import { resource, resourceVersion } from '@kukan/db'
import type { JobQueue } from '@kukan/queue'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  lakeCatalogFileNames,
  lakeCatalogKey,
  lakeDataPrefix,
  parseLakeCatalogKey,
  withLakeCatalogDraft,
  withLakeCatalogReader,
} from '@kukan/lake'
import {
  keyColumnsOf,
  LAKE_REBUILD_JOB_TYPE,
  MAX_PARQUET_SOURCE_SIZE,
  TABLE_SOURCE_FORMATS,
} from '@kukan/shared'
import type { NoTableReason } from '@kukan/shared'
import { reserveObject } from '../pipeline/storage-pointer'
import { touchResourceClaim, type ResourceClaim } from '../pipeline/pipeline-claim'
import {
  clearLakeLeftovers,
  commitLakeCatalog,
  currentLakeCatalog,
  listLakeKeys,
  loadLakeVersion,
  type LakeCatalogDeps,
  type LakeRefusal,
} from './lake-catalog'

/** A version's file, as the reader needs it to interpret the version again. */
export interface LakeVersionFile {
  resourceId: string
  version: number
  storageKey: string
  size: number | null
  format: string | null
}

/**
 * What reading a version came to: its table handed to `use`, why there is
 * none, or the error reading it failed with — not one that cut the work short,
 * nor one from `use`, which are thrown.
 */
export type LakeVersionRead<T> =
  | { table: true; value: T }
  | { table: false; reason: NoTableReason }
  | { table: false; failed: unknown }

/**
 * Interpret a version's file and hand its table, as a local Parquet path, to
 * `use` — or say why it has none. Supplied by the worker, which owns
 * interpretation.
 */
export type LakeVersionReader = <T>(
  file: LakeVersionFile,
  use: (parquetPath: string) => Promise<T>
) => Promise<LakeVersionRead<T>>

export interface LakeRebuildDeps extends LakeCatalogDeps {
  readVersion: LakeVersionReader
  /** To clear the generations the rebuild replaces, and to tell a version file gone from a bucket out of reach */
  storage: Pick<StorageAdapter, 'list' | 'deleteMany' | 'head'>
}

export interface LakeRebuildOptions {
  claim?: ResourceClaim | null
}

export interface LakeRebuildOutcome {
  /** The resource's catalog now, or null when no version remained to load */
  catalogKey: string | null
  loaded: { version: number; snapshotId: number }[]
  refused: LakeRefusal[]
}

/**
 * `resource_version` under another name, for a statement that reads it twice
 * or names it itself. Made on use: tests mock `@kukan/db` without the table.
 */
export const versionAlias = (name: string) => alias(resourceVersion, name)

/**
 * The versions of a format and a size an interpretation makes a table from,
 * not interpreted to nothing, and not refused over their key: what layer 2 is
 * to hold, decided from layer 1 alone (ADR-067 §6). The sweep's outstanding
 * versions (`pendingLakeIngestQuery`) are these, of an active resource, not
 * loaded yet. `purging` is left out with `purged`: the rebuild a purge runs is
 * what takes that version's rows out of layer 2.
 *
 * A recorded `no_table_reason` does not exclude a version here: over the cap or
 * out of memory, it is to be read again once that changes.
 */
export const lakeLoadable = (
  version: typeof resourceVersion | ReturnType<typeof versionAlias> = resourceVersion
) =>
  and(
    eq(version.state, 'active'),
    inArray(sql`lower(${version.format})`, [...TABLE_SOURCE_FORMATS]),
    isNotNull(version.size),
    lte(version.size, MAX_PARQUET_SOURCE_SIZE),
    sql`(${version.schema} IS NULL OR jsonb_array_length(${version.schema} -> 'columns') > 0)`,
    sql`${version.lakeIngestReason} IS NULL`
  )

/**
 * What a rebuild loads, in version order: {@link lakeLoadable}, less what it
 * found no table in. It records that without the empty schema the pipeline
 * writes, so without this every rebuild would leave that version behind a
 * later one and call for the next.
 */
const rebuildLoads = (
  version: typeof resourceVersion | ReturnType<typeof versionAlias> = resourceVersion
) => and(lakeLoadable(version), sql`${version.noTableReason} IS NULL`)

async function versionsToLoad(db: Database, resourceId: string) {
  return db
    .select({
      version: resourceVersion.version,
      storageKey: resourceVersion.storageKey,
      size: resourceVersion.size,
      format: resourceVersion.format,
      keyColumns: resourceVersion.lakeKeyColumns,
    })
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), rebuildLoads()))
    .orderBy(asc(resourceVersion.version))
}

/**
 * Whether loading a version into the resource's catalog would leave one
 * behind: a version a rebuild loads ({@link rebuildLoads}) not loaded, with a later one after it
 * (ADR-067 §6). A catalog only takes versions on top of the last, so such a
 * resource is rebuilt from layer 1 rather than added to.
 *
 * One rule for every way there: a resource the shared catalog held, whose
 * versions none are in its own; a site that skipped the releases between; an
 * older version whose loading failed for a while as a newer one arrived. It
 * reads nothing the shared catalog wrote, so it holds once that is gone.
 */
export async function lakeNeedsRebuild(db: Database, resourceId: string): Promise<boolean> {
  const later = versionAlias('later')
  const [row] = await db
    .select({ version: resourceVersion.version })
    .from(resourceVersion)
    .where(
      and(
        eq(resourceVersion.resourceId, resourceId),
        rebuildLoads(),
        isNull(resourceVersion.lakeSnapshotId),
        exists(
          db
            .select({})
            .from(later)
            .where(
              and(
                eq(later.resourceId, resourceVersion.resourceId),
                gt(later.version, resourceVersion.version),
                rebuildLoads(later)
              )
            )
        )
      )
    )
    .limit(1)
  return row !== undefined
}

/**
 * Resources with a version the shared catalog took and their own catalog does
 * not have yet, among those the hourly sweep moves (`active` ones): what is
 * left of the migration off it. Zero is what lets that catalog be dropped
 * (`shared-lake-catalog.ts`).
 */
export async function countUnmigratedLakeResources(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(resourceVersion.resourceId) })
    .from(resourceVersion)
    .innerJoin(resource, eq(resource.id, resourceVersion.resourceId))
    .where(
      and(
        eq(resource.state, 'active'),
        rebuildLoads(),
        isNotNull(resourceVersion.ducklakeSnapshotId),
        isNull(resourceVersion.lakeSnapshotId)
      )
    )
  return row?.count ?? 0
}

/**
 * What the resource's catalog is: none, one that cannot be read whole — its
 * object gone, or a file one of its snapshots reads — or one read whole, with
 * the files it reads (ADR-067 §6). Broken is one rule for every way it gets
 * there: a downgrade whose orphan sweep took the new layout, the database or
 * the bucket put back to another time, or `lake/` deleted by hand — answered by
 * the same rebuild, which reads layer 1 only. Whole, the files are what
 * {@link clearLakeLeftovers} keeps, so the catalog is read once for both.
 */
export async function inspectLakeCatalog(
  db: Database,
  deps: LakeCatalogDeps & { storage: Pick<StorageAdapter, 'head' | 'list'> },
  resourceId: string
): Promise<'broken' | { catalog: string; files: string[] } | null> {
  const catalog = await currentLakeCatalog(db, resourceId)
  if (catalog === null) return null
  if ((await deps.storage.head(catalog)) === null) return 'broken'

  const files = await withLakeCatalogReader(
    deps.lake,
    deps.store,
    { catalogKey: catalog },
    lakeCatalogFileNames
  )
  const dataPrefix = lakeDataPrefix(resourceId, parseLakeCatalogKey(catalog)!.generation)
  const present = new Set(
    (await listLakeKeys(deps.storage, dataPrefix)).map((key) => key.split('/').pop()!)
  )
  return files.some((name) => !present.has(name)) ? 'broken' : { catalog, files }
}

/**
 * Ask for the resource's layer 2 to be rebuilt, if it turns out to need it —
 * the handler decides, from {@link lakeNeedsRebuild} and
 * {@link inspectLakeCatalog} — and cleared of leftovers if not. One job waiting
 * is enough: it reads the state when it runs.
 */
export async function queueLakeRebuild(
  queue: Pick<JobQueue, 'enqueue'>,
  resourceId: string
): Promise<void> {
  await queue.enqueue(LAKE_REBUILD_JOB_TYPE, { resourceId }, { unlessWaiting: true })
}

/**
 * Rebuild a resource's catalog from layer 1 into a new generation, make it the
 * resource's, and delete every other generation.
 *
 * A version that no longer loads — its frozen key no longer identifies its
 * rows, or it is no longer read as a table — is recorded as such and left out;
 * the rebuild goes on without it. Anything else that fails throws, leaving the
 * resource's catalog as it was: the new generation's files are then the next
 * run's to delete.
 */
export async function rebuildResourceLake(
  db: Database,
  deps: LakeRebuildDeps,
  resourceId: string,
  opts: LakeRebuildOptions = {}
): Promise<LakeRebuildOutcome> {
  const from = await currentLakeCatalog(db, resourceId)
  const versions = await versionsToLoad(db, resourceId)
  const loaded: LakeRebuildOutcome['loaded'] = []
  const refused: LakeRefusal[] = []

  let catalogKey: string | null
  try {
    catalogKey = await withLakeCatalogDraft(
      deps.lake,
      deps.store,
      { resourceId, from, newGeneration: true },
      async (draft) => {
        // The key the table's current contents were loaded under, as an ingest
        // reads it off the head: the version loaded last.
        let headKey: string[] | null | undefined
        for (const v of versions) {
          if (opts.claim) await touchResourceClaim(db, opts.claim)
          // Not attached while the version is interpreted, so the heavy process
          // can have back what the last load kept (ADR-059)
          await draft.suspend()
          const keyColumns = keyColumnsOf(v.keyColumns)
          const read = await deps.readVersion(
            {
              resourceId,
              version: v.version,
              storageKey: v.storageKey,
              size: v.size,
              format: v.format,
            },
            (parquetPath) =>
              loadLakeVersion(draft.session, {
                resourceId,
                parquetPath,
                keyColumns,
                headKey,
              })
          )
          if (!read.table && 'failed' in read) {
            // Left out rather than holding up every version after it, and with
            // them a purge (ADR-067 §4): one that fails each time would stop
            // the rebuild for good. Unless the bucket is out of reach — then
            // every version would fail the same way, and none is this one's.
            await deps.storage.head(v.storageKey).catch(() => {
              throw read.failed
            })
            refused.push({ version: v.version, ingestFailed: true })
          } else if (!read.table) {
            refused.push({ version: v.version, noTable: read.reason })
          } else if ('fault' in read.value) {
            refused.push({ version: v.version, keyFault: read.value.fault })
          } else {
            loaded.push({ version: v.version, snapshotId: read.value.snapshotId })
            headKey = keyColumns
          }
        }
        if (loaded.length === 0) return null
        const to = lakeCatalogKey(resourceId, draft.generation)
        await reserveObject(db, to)
        await draft.publish(to)
        return to
      }
    )

    await commitLakeCatalog(db, {
      resourceId,
      from,
      to: catalogKey,
      snapshots: loaded,
      rebuilt: true,
      refused,
      claim: opts.claim,
    })
  } catch (err) {
    // The new generation, as far as it got: nothing names it, and a resource
    // whose rebuild keeps failing may have no other write to clear it
    await clearLakeLeftovers(db, deps.storage, resourceId, opts.claim).catch(() => {})
    throw err
  }
  await clearLakeLeftovers(db, deps.storage, resourceId, opts.claim)
  return { catalogKey, loaded, refused }
}
