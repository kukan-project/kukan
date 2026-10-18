/**
 * Rebuilding a resource's layer 2 from layer 1 (ADR-067 §4, §6), for real:
 * DuckDB, data files in a local directory standing in for the bucket, catalog
 * objects in a map, and the test database. Interpretation is stood in by a
 * reader that hands back a Parquet written per version.
 *
 * The property everything else rests on is the first case: after a rebuild
 * without a version, no byte of that version's own rows is left in layer 2.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeObjectStore } from '@kukan/lake'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  closeLakeInstances,
  diffVersions,
  lakeCatalogKey,
  lakeResourcePrefix,
  lakeTableName,
  parseLakeCatalogKey,
  releaseIdleLakeInstances,
  withBucketSession,
  withLakeCatalogReader,
} from '@kukan/lake'
import { ConflictError, getStorageKey } from '@kukan/shared'
import type { NoTableReason } from '@kukan/shared'
import {
  clearLakeLeftovers,
  currentLakeCatalog,
  deleteResourceLakes,
  ingestVersionIntoResourceCatalog,
} from '../../../services/lake/lake-catalog'
import {
  inspectLakeCatalog,
  lakeNeedsRebuild,
  rebuildResourceLake,
  type LakeVersionReader,
} from '../../../services/lake/lake-rebuild'
import { ResourceVersionService } from '../../../services/resource-version-service'
import { VersionDiffService } from '../../../services/version-diff-service'
import { PostgresJobQueue } from '@kukan/queue'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../../test-helpers/test-db'

const db = getTestDb()
/** A diff's request for a repair, which these cases do not look at. */
const noQueue = { enqueue: async () => 'job' }

let root: string
let lake: LakeConfig
let packageId: string
let resourceId: string

/**
 * The bucket: catalog objects in a map, data files where DuckDB wrote them
 * under `root`. Listing and deleting reach both, as they do in one bucket.
 */
function bucket() {
  const objects = new Map<string, Buffer>()
  const store: LakeObjectStore & Pick<StorageAdapter, 'head'> = {
    download: async (key) => {
      const bytes = objects.get(key)
      if (!bytes) throw new Error(`NoSuchKey: ${key}`)
      return Readable.from([bytes])
    },
    head: async (key) => {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.length } : null
    },
    upload: async (key, body) => {
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks))
    },
  }
  const dataFiles = async (prefix: string): Promise<string[]> => {
    const files = await readdir(join(root, prefix), { recursive: true }).catch(() => [])
    return files.map((f) => `${prefix}${f}`).filter((k) => k.endsWith('.parquet'))
  }
  /** Version files, which live outside this fake: present unless named here */
  const gone = new Set<string>()
  let reachable = true
  const storage = {
    head: async (key: string) => {
      if (!reachable) throw new Error('bucket out of reach')
      return gone.has(key) ? null : { size: 1 }
    },
    list: async (prefix: string) => ({
      objects: [
        ...[...objects.keys()].filter((k) => k.startsWith(prefix)),
        ...(await dataFiles(prefix)),
      ].map((key) => ({ key, lastModified: new Date() })),
    }),
    deleteMany: async (keys: string[]) => {
      for (const key of keys) {
        objects.delete(key)
        await rm(join(root, key), { force: true })
      }
      return keys
    },
  }
  return {
    store,
    storage,
    objects,
    dataFiles,
    gone,
    outOfReach: () => {
      reachable = false
    },
  }
}

/**
 * Interpretation, stood in: a Parquet per version, a reason it has none, or
 * `'fails'` for one whose reading fails.
 */
function reader(tables: Map<number, string | NoTableReason | 'fails'>): LakeVersionReader {
  return async (file, use) => {
    const table = tables.get(file.version)
    if (table === undefined) throw new Error(`no file for v${file.version}`)
    if (table === 'fails') return { table: false, failed: new Error(`v${file.version} unreadable`) }
    if (!table.endsWith('.parquet')) return { table: false, reason: table as NoTableReason }
    return { table: true, value: await use(table) }
  }
}

/** What the rebuild job does when there is nothing to rebuild: clear what the catalog does not read. */
async function clearAsTheJobDoes(
  deps: Parameters<typeof inspectLakeCatalog>[1] & {
    storage: Parameters<typeof clearLakeLeftovers>[1]
  }
) {
  const catalog = await inspectLakeCatalog(db, deps, resourceId)
  if (catalog === 'broken') throw new Error('the catalog is broken')
  return clearLakeLeftovers(db, deps.storage, resourceId, null, catalog ?? undefined)
}

async function parquet(name: string, rows: string): Promise<string> {
  const path = join(root, 'src', `${name}.parquet`)
  await withBucketSession(lake, (session) =>
    session.run(`COPY (SELECT * FROM (VALUES ${rows}) t(id, name)) TO '${path}' (FORMAT parquet)`)
  )
  return path
}

async function addVersion(
  version: number,
  extra: Partial<typeof resourceVersion.$inferInsert> = {}
) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    format: 'CSV',
    ...extra,
  })
}

async function versions() {
  return db
    .select({
      version: resourceVersion.version,
      lake: resourceVersion.lakeSnapshotId,
      keyFault: resourceVersion.lakeIngestReason,
      noTable: resourceVersion.noTableReason,
    })
    .from(resourceVersion)
    .where(eq(resourceVersion.resourceId, resourceId))
    .orderBy(resourceVersion.version)
}

beforeEach(async () => {
  await cleanDatabase()
  root = await mkdtemp(join(tmpdir(), 'lake-rebuild-'))
  await mkdir(join(root, 'src'))
  lake = {
    bucket: 'unused',
    region: 'us-east-1',
    s3UseSsl: false,
    s3AccessKey: 'unused',
    s3SecretKey: 'unused',
    limits: { memoryLimitMb: 256, threads: 1 },
    dataRoot: `${root}/`,
  }
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-lake-rebuild', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
  await db.insert(resourcePipeline).values({ resourceId })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  await closeLakeInstances()
  await closeTestDb()
})

describe('rebuildResourceLake', () => {
  it('leaves no row of a purged version in layer 2, and keeps the others diffable by key', async () => {
    const { store, storage, dataFiles } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a'), (2, 'b')`)],
      [2, await parquet('v2', `(1, 'a'), (2, 'secret'), (3, 'c')`)],
      [3, await parquet('v3', `(1, 'a'), (2, 'b'), (4, 'd')`)],
    ])
    for (const v of [1, 2, 3]) {
      await addVersion(v, { lakeKeyColumns: ['id'] })
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage },
        { resourceId, version: v, sourcePath: files.get(v)! }
      )
    }
    const before = parseLakeCatalogKey((await currentLakeCatalog(db, resourceId))!)!.generation
    await db
      .update(resourceVersion)
      .set({ state: 'purging' })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 2)))

    const outcome = await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(files) },
      resourceId
    )

    const key = outcome.catalogKey!
    const after = parseLakeCatalogKey(key)!.generation
    expect(after).not.toBe(before)
    expect(outcome.loaded.map((l) => l.version)).toEqual([1, 3])
    expect((await versions()).find((v) => v.version === 2)?.lake).toBeNull()
    // Everything under the resource is the new generation's
    const prefix = lakeResourcePrefix(resourceId)
    const remaining = await dataFiles(prefix)
    expect(remaining.every((k) => k.startsWith(`${prefix}${after}/`))).toBe(true)
    // …and none of it holds what only the purged version had
    const leaked = await withBucketSession(lake, (session) =>
      session.rows(
        `SELECT count(*) AS n FROM read_parquet([${remaining.map((k) => `'${join(root, k)}'`).join(', ')}], union_by_name => true)
         WHERE name = 'secret'`
      )
    )
    expect(leaked[0].n).toBe(0)

    const [v1, v3] = outcome.loaded
    const diff = await withLakeCatalogReader(lake, store, { catalogKey: key }, (session) =>
      diffVersions(session, {
        table: lakeTableName(resourceId),
        fromSnapshot: v1.snapshotId,
        toSnapshot: v3.snapshotId,
        key: ['id'],
      })
    )
    expect(diff).toMatchObject({ keyed: true, addedRows: 1, removedRows: 0, changedRows: 0 })
  })

  it('holds no instance while a version is interpreted, so the heavy process can have it back', async () => {
    const { store, storage } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, await parquet('v2', `(1, 'b')`)],
    ])
    await addVersion(1)
    await addVersion(2)
    const released: number[] = []
    const interpret = reader(files)
    const readVersion: LakeVersionReader = async (file, use) => {
      // What the heavy process asks for when it runs short (ADR-059)
      released.push(await releaseIdleLakeInstances())
      return interpret(file, use)
    }

    await rebuildResourceLake(db, { lake, store, storage, readVersion }, resourceId)

    expect(released[1]).toBe(1)
    expect((await versions()).every((r) => r.lake !== null)).toBe(true)
  })

  it('records a version that no longer loads, and goes on without it', async () => {
    const { store, storage } = bucket()
    const files = new Map<number, string>([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, 'not-records'],
      [3, await parquet('v3', `(1, 'a'), (1, 'b')`)],
    ])
    await addVersion(1)
    await addVersion(2)
    await addVersion(3, { lakeKeyColumns: ['id'] })

    const outcome = await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(files) },
      resourceId
    )

    expect(outcome.loaded.map((l) => l.version)).toEqual([1])
    expect(await versions()).toMatchObject([
      { version: 1, keyFault: null, noTable: null },
      { version: 2, lake: null, noTable: 'not-records' },
      { version: 3, lake: null, keyFault: 'key-not-unique' },
    ]) // Settled, not owed: the next version's ingest adds to the catalog
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(false)
  })

  it('leaves out a version whose reading fails, for good, and goes on with the rest', async () => {
    // One that fails each time would otherwise stop every rebuild of the
    // resource, a purge's included (ADR-067 §4)
    const { store, storage } = bucket()
    const files = new Map<number, string>([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, 'fails'],
      [3, await parquet('v3', `(1, 'a'), (2, 'b')`)],
    ])
    for (const v of [1, 2, 3]) await addVersion(v)

    const outcome = await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(files) },
      resourceId
    )

    expect(outcome.loaded.map((l) => l.version)).toEqual([1, 3])
    expect((await versions())[1]).toMatchObject({
      version: 2,
      lake: null,
      keyFault: 'ingest-failed',
    })
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(false)
  })

  it('takes back the key a version left out was verified under', async () => {
    // It vouched for a key over content layer 2 no longer holds (the OData
    // feed reads it)
    const { store, storage } = bucket()
    await addVersion(1, { lakeSnapshotId: 1, lakeKeyColumns: ['id'] })
    await db.update(resource).set({ hash: 'sha256:v1' }).where(eq(resource.id, resourceId))
    const service = new ResourceVersionService(db)
    expect(await service.liveLakeKey(resourceId)).toEqual(['id'])

    await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(new Map([[1, 'fails']])) },
      resourceId
    )

    expect(await service.liveLakeKey(resourceId)).toBeNull()
  })

  it('records nothing and throws when the bucket is out of reach', async () => {
    // Every version would fail the same way, and none of it is theirs
    const { store, storage, outOfReach } = bucket()
    const files = new Map<number, string>([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, 'fails'],
    ])
    for (const v of [1, 2]) await addVersion(v)
    outOfReach()

    await expect(
      rebuildResourceLake(db, { lake, store, storage, readVersion: reader(files) }, resourceId)
    ).rejects.toThrow('v2 unreadable')
    expect((await versions()).map((r) => r.keyFault)).toEqual([null, null])
    expect(await currentLakeCatalog(db, resourceId)).toBeNull()
  })

  it('leaves the resource with no catalog and nothing under its prefix when no version remains', async () => {
    const { store, storage, objects, dataFiles } = bucket()
    await addVersion(1)
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 1, sourcePath: await parquet('v1', `(1, 'a')`) }
    )
    await db
      .update(resourceVersion)
      .set({ state: 'purging' })
      .where(eq(resourceVersion.resourceId, resourceId))

    const outcome = await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(new Map()) },
      resourceId
    )

    expect(outcome.catalogKey).toBeNull()
    expect(await currentLakeCatalog(db, resourceId)).toBeNull()
    expect(objects.size).toBe(0)
    expect(await dataFiles(lakeResourcePrefix(resourceId))).toEqual([])
  })

  it('stops, writing nothing, once its claim is lost', async () => {
    const { store, storage } = bucket()
    await addVersion(1)

    await expect(
      rebuildResourceLake(
        db,
        {
          lake,
          store,
          storage,
          readVersion: reader(new Map([[1, await parquet('v1', `(1, 'a')`)]])),
        },
        resourceId,
        { claim: { id: crypto.randomUUID(), resourceId, owner: crypto.randomUUID() } }
      )
    ).rejects.toBeInstanceOf(ConflictError)
    expect(await currentLakeCatalog(db, resourceId)).toBeNull()
    expect((await versions())[0].lake).toBeNull()
  })
})

describe('lakeNeedsRebuild, from layer 1 alone (ADR-067 §6)', () => {
  it('holds for a version not loaded with a later one after it', async () => {
    // What a resource the shared catalog held finds, and a site that skipped
    // the releases between
    await addVersion(1)
    await addVersion(2, { lakeSnapshotId: 5 })
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(true)
  })

  it('does not hold when only the newest is still to be loaded, which is added on top', async () => {
    await addVersion(1, { lakeSnapshotId: 5 })
    await addVersion(2)
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(false)
  })

  it('does not count a later version that is no table', async () => {
    await addVersion(1)
    await addVersion(2, { format: 'PDF' })
    await addVersion(3, { noTableReason: 'not-records' })
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(false)
  })

  it('is answered by a rebuild that loads every version, one no catalog ever held included', async () => {
    const { store, storage } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, await parquet('v2', `(1, 'b')`)],
    ])
    await addVersion(1)
    await addVersion(2)

    const outcome = await rebuildResourceLake(
      db,
      { lake, store, storage, readVersion: reader(files) },
      resourceId
    )

    expect(outcome.loaded.map((l) => l.version)).toEqual([1, 2])
    expect(await lakeNeedsRebuild(db, resourceId)).toBe(false)
  })
})

describe('inspectLakeCatalog, and the rebuild that answers it (ADR-067 §6)', () => {
  /** Two versions loaded by key — the second a delete file beside a data file. */
  async function loaded() {
    const b = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a'), (2, 'b')`)],
      [2, await parquet('v2', `(1, 'a'), (2, 'B')`)],
    ])
    for (const v of [1, 2]) {
      await addVersion(v, { lakeKeyColumns: ['id'] })
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store: b.store, storage: b.storage },
        { resourceId, version: v, sourcePath: files.get(v)! }
      )
    }
    const deps = { lake, store: b.store, storage: { ...b.storage, head: b.store.head } }
    return { ...b, files, deps }
  }

  it('finds nothing wrong with a resource with no catalog, or one read whole', async () => {
    const empty = bucket()
    expect(
      (await inspectLakeCatalog(
        db,
        { lake, store: empty.store, storage: { ...empty.storage, head: empty.store.head } },
        resourceId
      )) === 'broken'
    ).toBe(false)

    const { deps } = await loaded()
    expect((await inspectLakeCatalog(db, deps, resourceId)) === 'broken').toBe(false)
  })

  it('finds the catalog object gone', async () => {
    const { deps, objects } = await loaded()
    objects.delete((await currentLakeCatalog(db, resourceId))!)

    expect((await inspectLakeCatalog(db, deps, resourceId)) === 'broken').toBe(true)
  })

  it('finds a file a snapshot reads gone, and a rebuild puts the history back', async () => {
    const { deps, files, dataFiles } = await loaded()
    const [lost] = await dataFiles(lakeResourcePrefix(resourceId))
    await rm(join(root, lost))
    expect((await inspectLakeCatalog(db, deps, resourceId)) === 'broken').toBe(true)

    await rebuildResourceLake(db, { ...deps, readVersion: reader(files) }, resourceId)

    expect((await inspectLakeCatalog(db, deps, resourceId)) === 'broken').toBe(false)
    expect(
      await new VersionDiffService(db, lake, deps.store, noQueue).diff(resourceId, 2, 1)
    ).toMatchObject({ available: true, keyed: true, changedRows: 1 })
  })

  it('reads a diff whose catalog is gone as not loaded yet, and asks for the rebuild', async () => {
    const { deps, objects } = await loaded()
    objects.delete((await currentLakeCatalog(db, resourceId))!)
    const queue = { enqueue: vi.fn().mockResolvedValue('job-1') }

    const view = await new VersionDiffService(db, lake, deps.store, queue).diff(resourceId, 2, 1)

    expect(view).toMatchObject({ available: false, reason: 'not-ingested' })
    expect(queue.enqueue).toHaveBeenCalledWith(
      'rebuild-lake-catalog',
      { resourceId },
      { unlessWaiting: true }
    )
  })
})

describe('clearLakeLeftovers', () => {
  const A = '0b9e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
  const B = '7c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f'

  /** A catalog object in each of two generations, and the pointer on `current`. */
  async function twoGenerations(current: string) {
    const b = bucket()
    for (const g of [A, B]) b.objects.set(lakeCatalogKey(resourceId, g), Buffer.from(g))
    const key = [...b.objects.keys()].find((k) => k.includes(`/${current}/`))!
    await db
      .update(resourcePipeline)
      .set({ lakeCatalogKey: key })
      .where(eq(resourcePipeline.resourceId, resourceId))
    return { ...b, key }
  }

  /** The claim the resource's pipeline row holds, taken here. */
  async function holdClaim() {
    const owner = crypto.randomUUID()
    const [row] = await db
      .update(resourcePipeline)
      .set({ claimOwner: owner, claimKind: 'job', claimOwnerAt: sql`NOW()` })
      .where(eq(resourcePipeline.resourceId, resourceId))
      .returning({ id: resourcePipeline.id })
    return { id: row.id, resourceId, owner }
  }

  it('keeps the generation the pointer names', async () => {
    const { storage, objects, key } = await twoGenerations(B)
    expect(await clearLakeLeftovers(db, storage, resourceId, await holdClaim())).toBe(1)
    expect([...objects.keys()]).toEqual([key])
  })

  it('deletes nothing when the pointer moves while the old generations are listed', async () => {
    const { storage, objects } = await twoGenerations(B)
    const other = [...objects.keys()].find((k) => k.includes(`/${A}/`))!
    const racing = {
      ...storage,
      list: async (prefix: string) => {
        // Another holder commits generation A in the meantime
        await db
          .update(resourcePipeline)
          .set({ lakeCatalogKey: other })
          .where(eq(resourcePipeline.resourceId, resourceId))
        return storage.list(prefix)
      },
    }
    await expect(clearLakeLeftovers(db, racing, resourceId)).rejects.toBeInstanceOf(ConflictError)
    expect(objects.size).toBe(2)
  })

  it('deletes nothing once its claim is lost', async () => {
    const { storage, objects } = await twoGenerations(B)
    await expect(
      clearLakeLeftovers(db, storage, resourceId, {
        id: crypto.randomUUID(),
        resourceId,
        owner: crypto.randomUUID(),
      })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(objects.size).toBe(2)
  })

  it("is what the next ingest clears an attempt's leftovers with, and nothing it reads", async () => {
    const { store, storage, objects, dataFiles } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a'), (2, 'b')`)],
      [2, await parquet('v2', `(1, 'a'), (2, 'B')`)],
    ])
    await addVersion(1, { lakeKeyColumns: ['id'] })
    await addVersion(2, { lakeKeyColumns: ['id'] })
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 1, sourcePath: files.get(1)! }
    )
    const prefix = lakeResourcePrefix(resourceId)
    const [tracked] = await dataFiles(prefix)
    // A Parquet written by an attempt that died before its commit, and a
    // generation a rebuild started and never finished
    const uncommitted = join(dirname(tracked), 'ducklake-uncommitted.parquet')
    await copyFile(join(root, tracked), join(root, uncommitted))
    const abandoned = `${prefix}${A}/data/main/t/ducklake-abandoned.parquet`
    await mkdir(dirname(join(root, abandoned)), { recursive: true })
    await copyFile(join(root, tracked), join(root, abandoned))
    const first = (await currentLakeCatalog(db, resourceId))!

    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 2, sourcePath: files.get(2)! }
    )

    const left = await dataFiles(prefix)
    expect(left).toContain(tracked)
    expect(left).not.toContain(uncommitted)
    expect(left).not.toContain(abandoned)
    // The catalog it replaced is parked for its readers, not deleted here
    expect(objects.has(first)).toBe(true)
    expect(
      await new VersionDiffService(db, lake, store, noQueue).diff(resourceId, 2, 1)
    ).toMatchObject({
      available: true,
      changedRows: 1,
    })
  })

  it('clears what an ingest that failed wrote, with no catalog yet or on top of one', async () => {
    const { store, storage, dataFiles } = bucket()
    const failing = {
      ...store,
      upload: async () => {
        throw new Error('upload failed')
      },
    }
    const prefix = lakeResourcePrefix(resourceId)
    await addVersion(1)
    await addVersion(2)
    const v1 = await parquet('v1', `(1, 'a')`)
    const v2 = await parquet('v2', `(1, 'a'), (2, 'b')`)

    // The first: no catalog, so nothing under the prefix is anyone's
    await expect(
      ingestVersionIntoResourceCatalog(
        db,
        { lake, store: failing, storage },
        { resourceId, version: 1, sourcePath: v1 }
      )
    ).rejects.toThrow('upload failed')
    expect(await dataFiles(prefix)).toEqual([])

    // On top of a catalog: what it reads stays
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 1, sourcePath: v1 }
    )
    const tracked = await dataFiles(prefix)
    await expect(
      ingestVersionIntoResourceCatalog(
        db,
        { lake, store: failing, storage },
        { resourceId, version: 2, sourcePath: v2 }
      )
    ).rejects.toThrow('upload failed')
    expect(await dataFiles(prefix)).toEqual(tracked)
  })

  it('leaves what neither the attempt nor its clearing could delete to the clearing retried later', async () => {
    const { store, storage, dataFiles } = bucket()
    const down = {
      store: {
        ...store,
        upload: async () => {
          throw new Error('upload failed')
        },
      },
      storage: {
        ...storage,
        deleteMany: async () => {
          throw new Error('delete failed')
        },
      },
    }
    const prefix = lakeResourcePrefix(resourceId)
    await addVersion(1)
    await addVersion(2)
    const v1 = await parquet('v1', `(1, 'a')`)
    const v2 = await parquet('v2', `(1, 'a'), (2, 'b')`)
    const deps = { lake, store, storage }

    // With no catalog yet
    await expect(
      ingestVersionIntoResourceCatalog(
        db,
        { lake, ...down },
        { resourceId, version: 1, sourcePath: v1 }
      )
    ).rejects.toThrow('upload failed')
    expect(await dataFiles(prefix)).not.toEqual([])
    expect(await clearAsTheJobDoes(deps)).toBeGreaterThan(0)
    expect(await dataFiles(prefix)).toEqual([])

    // On top of one: what it reads stays
    await ingestVersionIntoResourceCatalog(db, deps, { resourceId, version: 1, sourcePath: v1 })
    const tracked = await dataFiles(prefix)
    await expect(
      ingestVersionIntoResourceCatalog(
        db,
        { lake, ...down },
        { resourceId, version: 2, sourcePath: v2 }
      )
    ).rejects.toThrow('upload failed')
    expect(await clearAsTheJobDoes(deps)).toBeGreaterThan(0)
    expect(await dataFiles(prefix)).toEqual(tracked)
  })

  it('says so when a load committed and its clearing did not', async () => {
    const { store, storage } = bucket()
    await addVersion(1)

    const result = await ingestVersionIntoResourceCatalog(
      db,
      {
        lake,
        store,
        storage: {
          ...storage,
          // Something to clear, and no way to
          list: async () => ({
            objects: [
              { key: `${lakeResourcePrefix(resourceId)}x/stray`, lastModified: new Date() },
            ],
          }),
          deleteMany: async () => {
            throw new Error('delete failed')
          },
        },
      },
      { resourceId, version: 1, sourcePath: await parquet('v1', `(1, 'a')`) }
    )

    expect(result).toMatchObject({ snapshotId: expect.any(Number), uncleared: true })
    expect((await versions())[0].lake).not.toBeNull()
  })

  it('clears the generation a rebuild that failed started, and keeps the current one', async () => {
    const { store, storage, dataFiles } = bucket()
    await addVersion(1)
    await addVersion(2)
    const files = new Map([[1, await parquet('v1', `(1, 'a')`)]])
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 1, sourcePath: files.get(1)! }
    )
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 2, sourcePath: await parquet('v2', `(1, 'a'), (2, 'b')`) }
    )
    const prefix = lakeResourcePrefix(resourceId)
    const before = await dataFiles(prefix)
    const pointer = await currentLakeCatalog(db, resourceId)

    // v1 loads into the new generation; v2 cannot be read
    await expect(
      rebuildResourceLake(db, { lake, store, storage, readVersion: reader(files) }, resourceId)
    ).rejects.toThrow('no file for v2')

    expect(await currentLakeCatalog(db, resourceId)).toBe(pointer)
    expect(await dataFiles(prefix)).toEqual(before)
  })

  it("keeps a delete file the catalog it replaced still reads, for that catalog's readers", async () => {
    // A keyed load that deletes again from a data file with a delete file
    // replaces it; DuckLake schedules the old one for deletion, out of the
    // files the new catalog reads — but the replaced catalog, parked for the
    // readers that took its key, still reads it
    const { store, storage } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a'), (2, 'b'), (3, 'c')`)],
      [2, await parquet('v2', `(1, 'a'), (2, 'B'), (3, 'c')`)],
      [3, await parquet('v3', `(1, 'A'), (2, 'B'), (3, 'c')`)],
    ])
    const loaded: number[] = []
    let parked = ''
    for (const v of [1, 2, 3]) {
      await addVersion(v, { lakeKeyColumns: ['id'] })
      const { snapshotId } = (await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage },
        { resourceId, version: v, sourcePath: files.get(v)! }
      ))!
      loaded.push(snapshotId)
      if (v === 2) parked = (await currentLakeCatalog(db, resourceId))!
    }

    const diff = await withLakeCatalogReader(lake, store, { catalogKey: parked }, (session) =>
      diffVersions(session, {
        table: lakeTableName(resourceId),
        fromSnapshot: loaded[0],
        toSnapshot: loaded[1],
        key: ['id'],
      })
    )
    expect(diff).toMatchObject({ changedRows: 1 })
  })

  it('deletes nothing when the pointer names another catalog than the files came from', async () => {
    const { storage, objects } = await twoGenerations(B)
    await expect(
      clearLakeLeftovers(db, storage, resourceId, null, {
        catalog: lakeCatalogKey(resourceId, B),
        files: [],
      })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(objects.size).toBe(2)
  })
})

describe('deleteResourceLakes', () => {
  it("deletes everything under each resource's prefix, and nothing of another's", async () => {
    const { store, storage, objects, dataFiles } = bucket()
    await addVersion(1)
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage },
      { resourceId, version: 1, sourcePath: await parquet('v1', `(1, 'a')`) }
    )
    const other = lakeCatalogKey('9d3a2c1e-0b4f-4e6a-8c7d-112233445566', crypto.randomUUID())
    objects.set(other, Buffer.from('x'))

    expect(await deleteResourceLakes(storage, [resourceId])).toBeGreaterThan(1)

    expect(await dataFiles(lakeResourcePrefix(resourceId))).toEqual([])
    expect([...objects.keys()]).toEqual([other])
  })
})

describe('a purge of a tabular version (ADR-067 §4)', () => {
  it('rebuilds the layer 2 without it, and leaves the rest diffable', async () => {
    await ensureTestUser()
    const { store, storage, dataFiles } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a'), (2, 'b')`)],
      [2, await parquet('v2', `(1, 'a'), (2, 'secret')`)],
      [3, await parquet('v3', `(1, 'a'), (2, 'b'), (3, 'c')`)],
    ])
    for (const v of [1, 2, 3]) {
      await addVersion(v, { lakeKeyColumns: ['id'] })
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage },
        { resourceId, version: v, sourcePath: files.get(v)! }
      )
    }
    // Live on v3, so v2 is a middle version: only layer 1 and layer 2 are touched
    await db
      .update(resource)
      .set({ hash: 'sha256:v3', storageKey: getStorageKey(packageId, resourceId, 'v3') })
      .where(eq(resource.id, resourceId))
    const service = new ResourceVersionService(db)
    const queue = new PostgresJobQueue({ db })
    await service.claimPurge(resourceId, 2, TEST_USER_ID, 'personal data', queue)

    const result = await service.executePurge(resourceId, 2, {
      // One bucket, as in production: catalogs, data files and the version files
      storage: { ...store, ...storage, delete: async () => {} } as never,
      queue,
      lake,
      readVersion: reader(files),
    })

    expect(result.purged).toBe(true)
    const rows = await versions()
    expect(rows.find((r) => r.version === 2)).toMatchObject({ lake: null })
    expect(rows.filter((r) => r.version !== 2).every((r) => r.lake !== null)).toBe(true)
    const remaining = await dataFiles(lakeResourcePrefix(resourceId))
    const leaked = await withBucketSession(lake, (session) =>
      session.rows(
        `SELECT count(*) AS n FROM read_parquet([${remaining.map((k) => `'${join(root, k)}'`).join(', ')}], union_by_name => true)
         WHERE name = 'secret'`
      )
    )
    expect(leaked[0].n).toBe(0)
    expect(
      await new VersionDiffService(db, lake, store, noQueue).diff(resourceId, 3, 1)
    ).toMatchObject({
      available: true,
      keyed: true,
      addedRows: 1,
    })
  })

  it('retries only the cleanup when that was what failed', async () => {
    await ensureTestUser()
    const { store, storage } = bucket()
    const files = new Map([
      [1, await parquet('v1', `(1, 'a')`)],
      [2, await parquet('v2', `(1, 'secret')`)],
    ])
    // In a generation of their own catalog
    for (const v of [1, 2]) {
      await addVersion(v)
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage },
        { resourceId, version: v, sourcePath: files.get(v)! }
      )
    }
    await db
      .update(resource)
      .set({ hash: 'sha256:v2', storageKey: getStorageKey(packageId, resourceId, 'v2') })
      .where(eq(resource.id, resourceId))
    const service = new ResourceVersionService(db)
    const queue = new PostgresJobQueue({ db })
    await service.claimPurge(resourceId, 1, TEST_USER_ID, 'personal data', queue)
    const reads = vi.fn(reader(files))
    let failDeletes = true
    const deps = {
      storage: {
        ...store,
        ...storage,
        delete: async () => {},
        deleteMany: async (keys: string[]) => {
          if (failDeletes) throw new Error('storage unavailable')
          return storage.deleteMany(keys)
        },
      } as never,
      queue,
      lake,
      readVersion: reads as unknown as LakeVersionReader,
    }

    await expect(service.executePurge(resourceId, 1, deps)).rejects.toThrow('storage unavailable')
    const readsBefore = reads.mock.calls.length
    failDeletes = false
    expect((await service.executePurge(resourceId, 1, deps)).purged).toBe(true)

    expect(reads.mock.calls.length).toBe(readsBefore)
  })
})
