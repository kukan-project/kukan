/**
 * Loading versions into a resource's own catalog (ADR-067 §2), for real: the
 * DuckDB the worker runs, a local directory standing in for the bucket's data
 * files, a map standing in for its catalog objects, and the test database for
 * the rows and the pointer.
 *
 * What is pinned is the commit — which rows and pointers move together, and
 * what is left for the sweep when a write is turned away.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, sql } from 'drizzle-orm'
import { orphanedObject, resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeObjectStore } from '@kukan/lake'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  closeLakeInstances,
  diffVersions,
  lakeCatalogKey,
  lakeTableName,
  parseLakeCatalogKey,
  withBucketSession,
  withLakeCatalogReader,
} from '@kukan/lake'
import { ConflictError, getStorageKey } from '@kukan/shared'
import {
  commitLakeCatalog,
  currentLakeCatalog,
  ingestVersionIntoResourceCatalog,
} from '../../../services/lake/lake-catalog'
import { VersionDiffService } from '../../../services/version-diff-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()
/** A diff's request for a repair, which these cases do not look at. */
const noQueue = { enqueue: async () => 'job' }

let root: string
let lake: LakeConfig
let packageId: string
let resourceId: string

/** Clearing leftovers is `clearLakeLeftovers`'s, pinned in the rebuild's tests; here it finds none. */
const noLeftovers = {
  list: async () => ({ objects: [] }),
  deleteMany: async (keys: string[]) => keys,
}

function memoryStore() {
  const objects = new Map<string, Buffer>()
  let downloads = 0
  const store: LakeObjectStore & Pick<StorageAdapter, 'head'> & { downloads: () => number } = {
    downloads: () => downloads,
    head: async (key) => {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.length } : null
    },
    download: async (key) => {
      downloads++
      const bytes = objects.get(key)
      if (!bytes) throw new Error(`NoSuchKey: ${key}`)
      return Readable.from([bytes])
    },
    upload: async (key, body) => {
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks))
    },
  }
  return { store, objects }
}

async function addVersion(version: number, lakeKeyColumns: string[] | null = null) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    lakeKeyColumns,
  })
}

/** A version's interpreted table, as the pipeline would have it on local disk. */
async function parquet(name: string, rows: string): Promise<string> {
  const path = join(root, `${name}.parquet`)
  await withBucketSession(lake, (session) =>
    session.run(`COPY (SELECT * FROM (VALUES ${rows}) t(id, name)) TO '${path}' (FORMAT parquet)`)
  )
  return path
}

async function versionRow(version: number) {
  const [row] = await db
    .select({ snapshot: resourceVersion.lakeSnapshotId, reason: resourceVersion.lakeIngestReason })
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
  return row
}

async function tracked(): Promise<string[]> {
  return (await db.select({ key: orphanedObject.key }).from(orphanedObject)).map((r) => r.key)
}

beforeEach(async () => {
  await cleanDatabase()
  root = await mkdtemp(join(tmpdir(), 'lake-catalog-api-'))
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
    INSERT INTO package (name, state) VALUES ('test-pkg-lake-catalog', 'active') RETURNING id
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

describe('ingestVersionIntoResourceCatalog', () => {
  it('starts the catalog, points the resource at it, and records the snapshot', async () => {
    const { store, objects } = memoryStore()
    await addVersion(1)
    const sourcePath = await parquet('v1', `(1, 'a'), (2, 'b')`)

    const result = await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage: noLeftovers },
      { resourceId, version: 1, sourcePath }
    )

    const key = await currentLakeCatalog(db, resourceId)
    expect(parseLakeCatalogKey(key!)?.resourceId).toBe(resourceId)
    expect([...objects.keys()]).toEqual([key])
    expect((await versionRow(1)).snapshot).toBe(result!.snapshotId)
    // Its reservation is released by the commit that points at it
    expect(await tracked()).toEqual([])
  })

  it('applies the next version by key onto the catalog it opens, and parks the one it replaced', async () => {
    const { store } = memoryStore()
    await addVersion(1, ['id'])
    await addVersion(2, ['id'])
    const r1 = await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage: noLeftovers },
      { resourceId, version: 1, sourcePath: await parquet('v1', `(1, 'a'), (2, 'b'), (3, 'c')`) }
    )
    const k1 = await currentLakeCatalog(db, resourceId)
    const r2 = await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage: noLeftovers },
      { resourceId, version: 2, sourcePath: await parquet('v2', `(1, 'a'), (2, 'B'), (4, 'd')`) }
    )
    const k2 = await currentLakeCatalog(db, resourceId)

    expect(k2).not.toBe(k1)
    expect(parseLakeCatalogKey(k2!)?.generation).toBe(parseLakeCatalogKey(k1!)?.generation)
    expect(await tracked()).toEqual([k1])
    const diff = await withLakeCatalogReader(lake, store, { catalogKey: k2! }, (session) =>
      diffVersions(session, {
        table: lakeTableName(resourceId),
        fromSnapshot: r1!.snapshotId,
        toSnapshot: r2!.snapshotId,
        key: ['id'],
      })
    )
    expect(diff).toMatchObject({ keyed: true, addedRows: 1, removedRows: 1, changedRows: 1 })
  })

  it('records a key that cannot identify the rows, and writes nothing', async () => {
    const { store, objects } = memoryStore()
    await addVersion(1, ['id'])
    const sourcePath = await parquet('dup', `(1, 'a'), (1, 'b')`)

    expect(
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage: noLeftovers },
        { resourceId, version: 1, sourcePath }
      )
    ).toBeNull()
    expect(await versionRow(1)).toEqual({ snapshot: null, reason: 'key-not-unique' })
    expect(objects.size).toBe(0)
    expect(await currentLakeCatalog(db, resourceId)).toBeNull()
  })

  it('does not record a key fault for a run that lost its claim', async () => {
    const { store } = memoryStore()
    await addVersion(1, ['id'])
    const sourcePath = await parquet('dup', `(1, 'a'), (1, 'b')`)

    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage: noLeftovers },
      {
        resourceId,
        version: 1,
        sourcePath,
        claim: { id: crypto.randomUUID(), resourceId, owner: crypto.randomUUID() },
      }
    )
    expect(await versionRow(1)).toEqual({ snapshot: null, reason: null })
  })

  it('does not load an older version once a newer one is in', async () => {
    const { store } = memoryStore()
    await addVersion(1)
    await addVersion(2)
    await ingestVersionIntoResourceCatalog(
      db,
      { lake, store, storage: noLeftovers },
      { resourceId, version: 2, sourcePath: await parquet('v2', `(1, 'a')`) }
    )
    expect(
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage: noLeftovers },
        { resourceId, version: 1, sourcePath: await parquet('v1', `(1, 'z')`) }
      )
    ).toBeNull()
    expect((await versionRow(1)).snapshot).toBeNull()
  })
})

describe('a diff of a resource catalog', () => {
  it('reads the two versions out of the catalog, and the second time from the cache', async () => {
    const { store } = memoryStore()
    await addVersion(1, ['id'])
    await addVersion(2, ['id'])
    for (const [v, rows] of [
      [1, `(1, 'a'), (2, 'b')`],
      [2, `(1, 'a'), (2, 'B'), (3, 'c')`],
    ] as const) {
      await ingestVersionIntoResourceCatalog(
        db,
        { lake, store, storage: noLeftovers },
        { resourceId, version: v, sourcePath: await parquet(`v${v}`, rows) }
      )
    }
    const service = new VersionDiffService(db, lake, store, noQueue)

    const first = await service.diff(resourceId, 2)
    const downloaded = store.downloads()
    const second = await service.diff(resourceId, 2)

    expect(first).toMatchObject({ available: true, keyed: true, addedRows: 1, changedRows: 1 })
    expect(second).toEqual(first)
    expect(store.downloads()).toBe(downloaded)
  })
})

describe('commitLakeCatalog', () => {
  it('turns a write away when the pointer moved, and leaves its upload to the sweep', async () => {
    await addVersion(1)
    const generation = '0b9e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
    const theirs = lakeCatalogKey(resourceId, generation)
    const mine = lakeCatalogKey(resourceId, generation)
    await db
      .update(resourcePipeline)
      .set({ lakeCatalogKey: theirs })
      .where(eq(resourcePipeline.resourceId, resourceId))
    await db.insert(orphanedObject).values({ key: mine, expiresAt: sql`NOW() + INTERVAL '1 hour'` })

    await expect(
      commitLakeCatalog(db, {
        resourceId,
        from: null,
        to: mine,
        snapshots: [{ version: 1, snapshotId: 7 }],
      })
    ).rejects.toBeInstanceOf(ConflictError)

    expect(await currentLakeCatalog(db, resourceId)).toBe(theirs)
    expect((await versionRow(1)).snapshot).toBeNull()
    expect(await tracked()).toEqual([mine])
  })

  it('turns a write away when its claim was lost', async () => {
    await addVersion(1)
    const to = lakeCatalogKey(resourceId, '0b9e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b')
    await expect(
      commitLakeCatalog(db, {
        resourceId,
        from: null,
        to,
        snapshots: [{ version: 1, snapshotId: 7 }],
        // Another holder's, or one released since: nothing matches it any more
        claim: { id: crypto.randomUUID(), resourceId, owner: crypto.randomUUID() },
      })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(await currentLakeCatalog(db, resourceId)).toBeNull()
  })
})
