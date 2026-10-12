/**
 * A resource's own DuckLake catalog (ADR-067): one SQLite file per resource,
 * kept in the bucket next to the data files it describes.
 *
 * ```
 * lake/<resourceId>/<generation>/catalog.<token>.sqlite   a new key on every commit
 * lake/<resourceId>/<generation>/data/                    DATA_PATH
 * ```
 *
 * DuckDB opens a SQLite catalog only as a local file, so every use goes
 * through a copy: a writer downloads the current catalog, attaches it, writes,
 * detaches and uploads the result under a new key ({@link LakeCatalogDraft});
 * a reader downloads and attaches it read-only. Moving the resource's pointer
 * to the new key — the commit as the rest of KUKAN sees it — is the caller's.
 *
 * A key is never written twice, so a reader may cache a catalog's bytes by key
 * for as long as it likes.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { pipeline } from 'node:stream/promises'
import type { LakeConfig } from './config'
import { LAKE_DATA_PREFIX } from './config'
import type { BucketSession, LakeSession } from './connection'
import { disableDataInlining, openBucketSession } from './connection'
import { assertSafeIdentifier, sqlLiteral } from './sql'

/** Where a resource's catalogs are kept and read from — the storage adapter, in practice. */
export interface LakeObjectStore {
  download(key: string): Promise<Readable>
  upload(key: string, body: Readable): Promise<void>
}

/** Every object of a resource's layer 2 is under this prefix. */
export function lakeResourcePrefix(resourceId: string): string {
  return `${LAKE_DATA_PREFIX}${resourceId}/`
}

/** A generation: what a rebuild starts afresh in, and what it deletes the others by. */
export function newLakeGeneration(): string {
  return randomUUID()
}

/** A key a catalog has not been written to: each commit takes a new one. */
export function lakeCatalogKey(resourceId: string, generation: string): string {
  return `${lakeResourcePrefix(resourceId)}${generation}/catalog.${randomUUID()}.sqlite`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CATALOG_KEY = new RegExp(
  `^${LAKE_DATA_PREFIX}(${UUID})/(${UUID})/catalog\\.${UUID}\\.sqlite$`
)
const RESOURCE_KEY = new RegExp(`^${LAKE_DATA_PREFIX}(${UUID})/`)

/** The resource whose layer 2 a key is under, or null for any other key. */
export function lakeResourceOfKey(key: string): string | null {
  return RESOURCE_KEY.exec(key)?.[1] ?? null
}

/** The resource and generation a catalog key belongs to, or null for any other key. */
export function parseLakeCatalogKey(
  key: string
): { resourceId: string; generation: string } | null {
  const parts = CATALOG_KEY.exec(key)
  return parts ? { resourceId: parts[1], generation: parts[2] } : null
}

/** Where a generation's data files are kept: its catalogs' `DATA_PATH`, as a key prefix. */
export function lakeDataPrefix(resourceId: string, generation: string): string {
  return `${lakeResourcePrefix(resourceId)}${generation}/data/`
}

function dataPath(config: LakeConfig, resourceId: string, generation: string): string {
  const root = config.dataRoot ?? `s3://${config.bucket}/`
  return `${root}${lakeDataPrefix(resourceId, generation)}`
}

/** What every local copy of a catalog is made under, in the temp directory. */
const LOCAL_COPY_PREFIX = 'kukan-lake-catalog-'

/**
 * Remove the local catalog copies a killed process left behind: a draft or a
 * reader removes its own copy however it ends, short of the process dying.
 * Only those untouched for `olderThanMs`, since another process on the host —
 * the web beside a worker in development — may have one open now.
 *
 * @returns how many were removed.
 */
export async function removeStaleLakeCatalogCopies(
  config: Pick<LakeConfig, 'tempDir'>,
  olderThanMs: number
): Promise<number> {
  const dir = config.tempDir ?? tmpdir()
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  for (const name of await readdir(dir)) {
    if (!name.startsWith(LOCAL_COPY_PREFIX)) continue
    const path = join(dir, name)
    const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Infinity }))
    if (mtimeMs >= cutoff) continue
    await rm(path, { recursive: true, force: true })
    removed++
  }
  return removed
}

/** An alias of its own, so catalogs open side by side on one instance do not collide. */
function catalogAlias(): string {
  return `lake_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * ATTACH a local catalog file.
 *
 * `OVERRIDE_DATA_PATH` because the catalog records the data path it was
 * created with and refuses another, while the files are recorded relative to
 * it (ADR-067 §7, measurement 9): a bucket moved whole is read where it now is,
 * and one whose files were not moved reads as missing, which the caller
 * rebuilds from.
 */
async function attach(
  session: { run(sql: string): Promise<void> },
  file: string,
  alias: string,
  path: string,
  readOnly: boolean
): Promise<void> {
  await session.run(
    `ATTACH ${sqlLiteral(`ducklake:sqlite:${file}`)} AS ${assertSafeIdentifier(alias)} ` +
      `(DATA_PATH ${sqlLiteral(path)}, OVERRIDE_DATA_PATH true${readOnly ? ', READ_ONLY' : ''})`
  )
}

/**
 * Detach a catalog in cleanup, ending first any transaction the session left
 * open: DETACH refuses while one is, and a catalog left attached stays on the
 * shared instance for as long as the instance lives. Not for publishing —
 * rolling back there would upload the catalog without the writes.
 */
async function detachDiscarding(
  session: { run(sql: string): Promise<void> },
  alias: string
): Promise<void> {
  await session.run('ROLLBACK').catch(() => {})
  await session.run(`DETACH ${alias}`)
}

async function download(store: LakeObjectStore, key: string, file: string): Promise<void> {
  await pipeline(await store.download(key), createWriteStream(file))
}

/**
 * A catalog being written: attached under {@link session}'s alias until it is
 * published or disposed of.
 */
export interface LakeCatalogDraft {
  readonly session: LakeSession
  readonly resourceId: string
  readonly generation: string
  /** Whether it was started empty rather than downloaded */
  readonly created: boolean
  /**
   * Detach and give the connection back, keeping the local copy: the next
   * statement on {@link session} attaches it again. For a writer that does
   * other heavy work between loads — a rebuild interpreting the next version
   * in the heavy process — so the instance is idle meanwhile and the memory
   * it keeps can be given back (`releaseIdleLakeInstances`).
   *
   * Refuses while a transaction is open, as DETACH does.
   */
  suspend(): Promise<void>
  /**
   * Detach and upload to `key`, which must be one {@link lakeCatalogKey} gave
   * for this resource and generation. The session is closed after.
   *
   * Refuses a file with a journal beside it: the main file is consistent only
   * together with one (ADR-067 §2), and what is uploaded has to stand alone.
   */
  publish(key: string): Promise<void>
  /**
   * Close and remove the local copy, whether or not it was published. Safe to
   * call twice. A draft not published is discarded: a write that died is never
   * reused (ADR-067 §2).
   */
  dispose(): Promise<void>
}

export interface LakeCatalogDraftOptions {
  resourceId: string
  /** The resource's current catalog, or null when it has none */
  from: string | null
  /** Start empty in a new generation, ignoring `from` — a rebuild */
  newGeneration?: boolean
}

/** Open a resource's catalog for writing. */
export async function openLakeCatalogDraft(
  config: LakeConfig,
  store: LakeObjectStore,
  opts: LakeCatalogDraftOptions
): Promise<LakeCatalogDraft> {
  const fresh = opts.from === null || opts.newGeneration === true
  let generation: string
  if (fresh) {
    generation = newLakeGeneration()
  } else {
    const parsed = parseLakeCatalogKey(opts.from!)
    if (!parsed || parsed.resourceId !== opts.resourceId) {
      throw new Error(`Not a catalog of resource ${opts.resourceId}: ${opts.from}`)
    }
    generation = parsed.generation
  }

  const dir = await mkdtemp(join(config.tempDir ?? tmpdir(), LOCAL_COPY_PREFIX))
  const file = join(dir, 'catalog.sqlite')
  const alias = catalogAlias()
  const path = dataPath(config, opts.resourceId, generation)
  /** The connection the copy is attached on, or null while suspended */
  let bucket: BucketSession | null = null
  let disposed = false

  const dispose = async () => {
    if (disposed) return
    disposed = true
    if (bucket) {
      await detachDiscarding(bucket, alias).catch(() => {})
      await bucket.close().catch(() => {})
      bucket = null
    }
    await rm(dir, { recursive: true, force: true })
  }

  const attached = async (): Promise<BucketSession> => {
    if (disposed) throw new Error('Catalog draft already disposed of')
    if (bucket) return bucket
    const opened = await openBucketSession(config)
    try {
      await attach(opened, file, alias, path, false)
    } catch (err) {
      await opened.close().catch(() => {})
      throw err
    }
    bucket = opened
    return opened
  }

  const suspend = async () => {
    if (!bucket) return
    const opened = bucket
    await opened.run(`DETACH ${alias}`)
    bucket = null
    await opened.close()
  }

  try {
    if (!fresh) await download(store, opts.from!, file)
    await disableDataInlining(await attached(), alias)
  } catch (err) {
    await dispose()
    throw err
  }

  const session: LakeSession = {
    catalog: alias,
    run: async (sql) => (await attached()).run(sql),
    rows: async (sql) => (await attached()).rows(sql),
    interrupt: () => bucket?.interrupt(),
    close: dispose,
  }

  return {
    session,
    resourceId: opts.resourceId,
    generation,
    created: fresh,
    suspend,
    async publish(key) {
      const target = parseLakeCatalogKey(key)
      if (target?.resourceId !== opts.resourceId || target.generation !== generation) {
        throw new Error(`Not a key for this catalog's generation: ${key}`)
      }
      await suspend()
      for (const suffix of ['-journal', '-wal']) {
        if (existsSync(file + suffix)) {
          throw new Error(`Catalog left a ${suffix.slice(1)} behind; refusing to publish it`)
        }
      }
      await store.upload(key, createReadStream(file))
      await dispose()
    },
    dispose,
  }
}

/** {@link openLakeCatalogDraft}, disposed of whatever `fn` does. */
export async function withLakeCatalogDraft<T>(
  config: LakeConfig,
  store: LakeObjectStore,
  opts: LakeCatalogDraftOptions,
  fn: (draft: LakeCatalogDraft) => Promise<T>
): Promise<T> {
  const draft = await openLakeCatalogDraft(config, store, opts)
  try {
    return await fn(draft)
  } finally {
    await draft.dispose()
  }
}

/** Catalog bytes by key. Keys are never rewritten, so nothing is invalidated. */
export interface LakeCatalogCache {
  get(key: string): Buffer | undefined
  set(key: string, bytes: Buffer): void
}

export interface LakeCatalogReaderOptions {
  catalogKey: string
  cache?: LakeCatalogCache
}

/**
 * Open a resource's catalog read-only. Closing the session detaches it and
 * removes the local copy.
 *
 * Each session writes its own copy of the bytes: DuckDB will not attach one
 * file twice on an instance, and a copy shared between sessions could not be
 * removed while another still had it open.
 */
export async function openLakeCatalogReader(
  config: LakeConfig,
  store: LakeObjectStore,
  opts: LakeCatalogReaderOptions
): Promise<LakeSession> {
  const parsed = parseLakeCatalogKey(opts.catalogKey)
  if (!parsed) throw new Error(`Not a catalog key: ${opts.catalogKey}`)

  const dir = await mkdtemp(join(config.tempDir ?? tmpdir(), LOCAL_COPY_PREFIX))
  const file = join(dir, 'catalog.sqlite')
  const removeDir = () => rm(dir, { recursive: true, force: true })
  try {
    if (opts.cache) {
      // Taken in once, for the cache and the file both
      let bytes = opts.cache.get(opts.catalogKey)
      if (!bytes) {
        bytes = await buffer(await store.download(opts.catalogKey))
        opts.cache.set(opts.catalogKey, bytes)
      }
      await writeFile(file, bytes)
    } else {
      await download(store, opts.catalogKey, file)
    }
  } catch (err) {
    await removeDir()
    throw err
  }

  const alias = catalogAlias()
  const bucket = await openBucketSession(config).catch(async (err) => {
    await removeDir()
    throw err
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await detachDiscarding(bucket, alias).catch(() => {})
    await bucket.close().catch(() => {})
    await removeDir()
  }
  try {
    await attach(bucket, file, alias, dataPath(config, parsed.resourceId, parsed.generation), true)
  } catch (err) {
    await close()
    throw err
  }
  return { ...bucket, catalog: alias, close }
}

/**
 * The names of every file the catalog's snapshots read — data and delete files,
 * of every snapshot, not only the current one. DuckLake gives each a name of
 * its own (a UUID), so a name alone finds it under the generation's `data/`,
 * whichever directory below it holds it.
 *
 * With them, the files it has scheduled for deletion: a delete file a later
 * one replaced is no longer this catalog's, but the catalog it was committed
 * over still reads it, and stays parked for its readers (ADR-067 §1).
 */
export async function lakeCatalogFileNames(session: LakeSession): Promise<string[]> {
  const meta = `__ducklake_metadata_${assertSafeIdentifier(session.catalog)}`
  const rows = await session.rows(
    ['ducklake_data_file', 'ducklake_delete_file', 'ducklake_files_scheduled_for_deletion']
      .map((table) => `SELECT path FROM ${meta}.${table}`)
      .join(' UNION ALL ')
  )
  return rows.map((row) => String(row.path).split('/').pop()!)
}

/** {@link openLakeCatalogReader}, closed whatever `fn` does. */
export async function withLakeCatalogReader<T>(
  config: LakeConfig,
  store: LakeObjectStore,
  opts: LakeCatalogReaderOptions,
  fn: (session: LakeSession) => Promise<T>
): Promise<T> {
  const session = await openLakeCatalogReader(config, store, opts)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}
