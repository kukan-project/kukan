/**
 * A resource's own catalog (ADR-067), driven for real: DuckDB, the `sqlite` and
 * `ducklake` extensions, and data files in a local directory standing in for
 * the bucket. What is pinned is the life of one catalog — created, written,
 * published, opened again, read — not DuckLake itself.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { LakeConfig } from '../config'
import { closeLakeInstances, releaseIdleLakeInstances, withBucketSession } from '../connection'
import { diffVersions } from '../diff'
import { ingestParquetVersion } from '../ingest'
import {
  lakeCatalogFileNames,
  lakeCatalogKey,
  lakeDataPrefix,
  lakeResourcePrefix,
  openLakeCatalogDraft,
  openLakeCatalogReader,
  parseLakeCatalogKey,
  removeStaleLakeCatalogCopies,
  withLakeCatalogDraft,
  withLakeCatalogReader,
  type LakeCatalogCache,
  type LakeObjectStore,
} from '../catalog'
import { lakeTableExists } from '../table'

const RESOURCE = '429ff69d-7b24-4a8f-a0ec-671bcceee31e'
const OTHER = '9d3a2c1e-0b4f-4e6a-8c7d-112233445566'

/** The bucket, as far as catalogs go: bytes by key, and a count of downloads. */
function memoryStore() {
  const objects = new Map<string, Buffer>()
  let downloads = 0
  const store: LakeObjectStore = {
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
  return { store, objects, downloads: () => downloads }
}

let root: string
let config: LakeConfig

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lake-catalog-test-'))
  config = {
    bucket: 'unused',
    region: 'us-east-1',
    s3UseSsl: false,
    s3AccessKey: 'unused',
    s3SecretKey: 'unused',
    limits: { memoryLimitMb: 256, threads: 1 },
    dataRoot: `${root}/`,
    // Its own, so another suite's catalogs open at the same time are not counted
    tempDir: root,
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  await closeLakeInstances()
})

/** Local copies a draft or a reader left behind in the temp directory. */
async function leftovers(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith('kukan-lake-catalog-'))
}

describe('catalog keys', () => {
  it('are read back into their resource and generation, and nothing else is', () => {
    const generation = '0b9e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
    const key = lakeCatalogKey(RESOURCE, generation)
    expect(key.startsWith(`${lakeResourcePrefix(RESOURCE)}${generation}/catalog.`)).toBe(true)
    expect(parseLakeCatalogKey(key)).toEqual({ resourceId: RESOURCE, generation })
    expect(lakeCatalogKey(RESOURCE, generation)).not.toBe(key)
    expect(parseLakeCatalogKey(`lake/main/res_x/ducklake-1.parquet`)).toBeNull()
    expect(
      parseLakeCatalogKey(`${lakeResourcePrefix(RESOURCE)}${generation}/data/x.parquet`)
    ).toBeNull()
  })
})

/** An exclusive lock on a SQLite file, held by another process until released. */
async function holdExclusive(file: string): Promise<() => Promise<void>> {
  const holder = spawn(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `const db = new (require('node:sqlite').DatabaseSync)(${JSON.stringify(file)});` +
        "db.exec('BEGIN EXCLUSIVE'); process.stdout.write('held');" +
        "process.stdin.on('end', () => process.exit(0)).resume()",
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )
  await once(holder.stdout, 'data')
  return async () => {
    holder.stdin.end()
    await once(holder, 'exit')
  }
}

describe('a catalog draft', () => {
  it('starts empty with inlining off, and keeps it off once published and reopened', async () => {
    const { store } = memoryStore()
    let key = ''
    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: null },
      async (draft) => {
        expect(draft.created).toBe(true)
        await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t (id INTEGER)`)
        key = lakeCatalogKey(RESOURCE, draft.generation)
        await draft.publish(key)
      }
    )

    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: key },
      async (draft) => {
        expect(draft.created).toBe(false)
        const catalog = draft.session.catalog
        const [option] = await draft.session.rows(
          `SELECT value FROM ducklake_options('${catalog}') WHERE option_name = 'data_inlining_row_limit'`
        )
        expect(option.value).toBe('0')
        // One row still lands in a file rather than in the catalog
        await draft.session.run(`INSERT INTO ${catalog}.t VALUES (1)`)
        const files = await draft.session.rows(
          `SELECT * FROM ducklake_list_files('${catalog}', 't')`
        )
        expect(files).toHaveLength(1)
      }
    )
  })

  it('carries its snapshot numbering on from the catalog it was opened from', async () => {
    const { store } = memoryStore()
    const first = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await first.session.run(`CREATE TABLE ${first.session.catalog}.t AS SELECT 1 AS id`)
    const k1 = lakeCatalogKey(RESOURCE, first.generation)
    await first.publish(k1)

    const second = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: k1 })
    expect(second.generation).toBe(first.generation)
    const before = await second.session.rows(
      `SELECT max(snapshot_id) AS id FROM ducklake_snapshots('${second.session.catalog}')`
    )
    await second.session.run(`INSERT INTO ${second.session.catalog}.t VALUES (2)`)
    const k2 = lakeCatalogKey(RESOURCE, second.generation)
    await second.publish(k2)

    await withLakeCatalogReader(config, store, { catalogKey: k2 }, async (session) => {
      const at = (n: number) =>
        session.rows(`SELECT count(*) AS n FROM ${session.catalog}.t AT (VERSION => ${n})`)
      const latest = Number(before[0].id) + 1
      expect((await at(latest - 1))[0].n).toBe(1)
      expect((await at(latest))[0].n).toBe(2)
    })
  })

  it('gives its instance back while suspended, and carries on where it left off', async () => {
    const { store } = memoryStore()
    await releaseIdleLakeInstances()
    const draft = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t AS SELECT 1 AS id`)
    expect(await releaseIdleLakeInstances()).toBe(0)

    await draft.suspend()
    expect(await releaseIdleLakeInstances()).toBe(1)

    await draft.session.run(`INSERT INTO ${draft.session.catalog}.t VALUES (2)`)
    const key = lakeCatalogKey(RESOURCE, draft.generation)
    await draft.publish(key)
    await withLakeCatalogReader(config, store, { catalogKey: key }, async (session) => {
      const [row] = await session.rows(`SELECT count(*) AS n FROM ${session.catalog}.t`)
      expect(row.n).toBe(2)
    })
  })

  it('leaves no journal beside what it publishes, and refuses a file that has one', async () => {
    const { store, objects } = memoryStore()
    const draft = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t (id INTEGER)`)
    await draft.publish(lakeCatalogKey(RESOURCE, draft.generation))
    expect(objects.size).toBe(1)

    const stray = await openLakeCatalogDraft(config, store, { resourceId: OTHER, from: null })
    await stray.session.run(`CREATE TABLE ${stray.session.catalog}.t (id INTEGER)`)
    const [dir] = (await leftovers()).filter((name) =>
      existsSync(join(root, name, 'catalog.sqlite'))
    )
    await writeFile(join(root, dir, 'catalog.sqlite-journal'), 'x')
    await expect(stray.publish(lakeCatalogKey(OTHER, stray.generation))).rejects.toThrow(/journal/)
    await stray.dispose()
    expect(objects.size).toBe(1)
  })

  it('uploads nothing and leaves nothing behind when disposed of unpublished', async () => {
    const { store, objects } = memoryStore()
    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: null },
      async (draft) => {
        await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t (id INTEGER)`)
      }
    )
    expect(objects.size).toBe(0)
    expect(await leftovers()).toEqual([])
  })

  it('leaves nothing behind when it cannot be opened, and the next one opens', async () => {
    const { store } = memoryStore()
    const missing = lakeCatalogKey(RESOURCE, '0b9e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b')
    await expect(
      openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: missing })
    ).rejects.toThrow(/NoSuchKey/)
    expect(await leftovers()).toEqual([])
    await withLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null }, async () => {})
  })

  it('refuses a key of another resource or generation', async () => {
    const { store } = memoryStore()
    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: null },
      async (draft) => {
        await expect(draft.publish(lakeCatalogKey(OTHER, draft.generation))).rejects.toThrow()
        await expect(
          openLakeCatalogDraft(config, store, {
            resourceId: OTHER,
            from: lakeCatalogKey(RESOURCE, draft.generation),
          })
        ).rejects.toThrow(/Not a catalog of resource/)
      }
    )
  })

  it('starts a new generation for a rebuild, whatever it was opened from', async () => {
    const { store } = memoryStore()
    const first = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await first.session.run(`CREATE TABLE ${first.session.catalog}.t (id INTEGER)`)
    const k1 = lakeCatalogKey(RESOURCE, first.generation)
    await first.publish(k1)

    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: k1, newGeneration: true },
      async (draft) => {
        expect(draft.created).toBe(true)
        expect(draft.generation).not.toBe(first.generation)
        const tables = await draft.session.rows(
          `SELECT 1 FROM ducklake_table_info('${draft.session.catalog}')`
        )
        expect(tables).toEqual([])
      }
    )
  })

  it('opens two resources side by side on one instance', async () => {
    const { store } = memoryStore()
    const a = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    const b = await openLakeCatalogDraft(config, store, { resourceId: OTHER, from: null })
    expect(a.session.catalog).not.toBe(b.session.catalog)
    await a.session.run(`CREATE TABLE ${a.session.catalog}.t AS SELECT 1 AS id`)
    await b.session.run(`CREATE TABLE ${b.session.catalog}.t AS SELECT 2 AS id`)
    await a.publish(lakeCatalogKey(RESOURCE, a.generation))
    await b.publish(lakeCatalogKey(OTHER, b.generation))
  })

  it('reads nothing of the catalog beside it, for a table it has or not', async () => {
    const { store } = memoryStore()
    const b = await openLakeCatalogDraft(config, store, { resourceId: OTHER, from: null })
    const [bDir] = await leftovers()
    const a = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await a.session.run(`CREATE TABLE ${a.session.catalog}.t AS SELECT 1 AS id`)

    // A commit to b, held: a read of b now waits out SQLite's busy timeout and
    // fails. From another process, as SQLite's file locks are per process.
    const release = await holdExclusive(join(root, bDir, 'catalog.sqlite'))
    try {
      expect(await lakeTableExists(a.session, 't')).toBe(true)
      expect(await lakeTableExists(a.session, 'missing')).toBe(false)
      // Not a "Did you mean" looked for in every catalog on the instance
      const catalog = a.session.catalog
      await expect(a.session.rows(`SELECT * FROM ${catalog}.missing`)).rejects.toThrow(
        /Catalog Error/
      )
      await expect(a.session.rows(`SELECT * FROM ${catalog}.t AT (VERSION => 0)`)).rejects.toThrow(
        /Catalog Error/
      )
    } finally {
      await release()
      await a.dispose()
      await b.dispose()
    }
  })
})

/** The catalogs attached to the lake's instance right now, other than its own databases. */
async function attachedCatalogs(): Promise<string[]> {
  return withBucketSession(config, async (session) =>
    (
      await session.rows(
        `SELECT database_name FROM duckdb_databases() WHERE database_name LIKE 'lake\\_%' ESCAPE '\\'`
      )
    ).map((r) => String(r.database_name))
  )
}

describe('cleaning up', () => {
  it('removes the copies a killed process left, and none still in use or not its own', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    for (const name of ['kukan-lake-catalog-dead', 'kukan-lake-catalog-live', 'other-dead']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'catalog.sqlite'), 'x')
      if (name.endsWith('dead')) await utimes(join(root, name), hourAgo, hourAgo)
    }

    expect(await removeStaleLakeCatalogCopies(config, 30 * 60 * 1000)).toBe(1)
    expect(await leftovers()).toEqual(['kukan-lake-catalog-live'])
    expect(existsSync(join(root, 'other-dead'))).toBe(true)
  })

  it('detaches a draft disposed of inside an open transaction', async () => {
    const { store } = memoryStore()
    const draft = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await draft.session.run('BEGIN')
    await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t (id INTEGER)`)
    await draft.dispose()
    expect(await attachedCatalogs()).toEqual([])
  })

  it('does not publish what an open transaction holds', async () => {
    // Rolling back to detach would upload the catalog without the writes
    const { store, objects } = memoryStore()
    const draft = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await draft.session.run('BEGIN')
    await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t (id INTEGER)`)
    await expect(draft.publish(lakeCatalogKey(RESOURCE, draft.generation))).rejects.toThrow()
    await draft.dispose()
    expect(objects.size).toBe(0)
    expect(await attachedCatalogs()).toEqual([])
  })

  it('detaches a reader closed inside an open transaction', async () => {
    const { store } = memoryStore()
    let key = ''
    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: null },
      async (draft) => {
        await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t AS SELECT 1 AS id`)
        key = lakeCatalogKey(RESOURCE, draft.generation)
        await draft.publish(key)
      }
    )
    const reader = await openLakeCatalogReader(config, store, { catalogKey: key })
    await reader.run('BEGIN')
    await reader.rows(`SELECT * FROM ${reader.catalog}.t`)
    await reader.close()
    expect(await attachedCatalogs()).toEqual([])
  })
})

describe('a catalog reader', () => {
  it('reads without writing, and downloads a key once when given a cache', async () => {
    const { store, downloads } = memoryStore()
    let key = ''
    await withLakeCatalogDraft(
      config,
      store,
      { resourceId: RESOURCE, from: null },
      async (draft) => {
        await draft.session.run(`CREATE TABLE ${draft.session.catalog}.t AS SELECT 1 AS id`)
        key = lakeCatalogKey(RESOURCE, draft.generation)
        await draft.publish(key)
      }
    )

    const held = new Map<string, Buffer>()
    const cache: LakeCatalogCache = { get: (k) => held.get(k), set: (k, v) => void held.set(k, v) }
    for (let i = 0; i < 2; i++) {
      await withLakeCatalogReader(config, store, { catalogKey: key, cache }, async (session) => {
        expect((await session.rows(`SELECT count(*) AS n FROM ${session.catalog}.t`))[0].n).toBe(1)
        await expect(session.run(`INSERT INTO ${session.catalog}.t VALUES (2)`)).rejects.toThrow()
      })
    }
    expect(downloads()).toBe(1)
    expect(await leftovers()).toEqual([])
  })
})

describe('ingest and diff on a resource catalog', () => {
  it('load versions by key across commits, and diff them through a reader', async () => {
    const { store } = memoryStore()
    // Two versions of one table, keyed by id: one row changed, one gone, one new
    const v1 = join(root, 'v1.parquet')
    const v2 = join(root, 'v2.parquet')
    await withBucketSession(config, async (session) => {
      await session.run(
        `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) t(id, name)) TO '${v1}' (FORMAT parquet)`
      )
      await session.run(
        `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'B'), (4, 'd')) t(id, name)) TO '${v2}' (FORMAT parquet)`
      )
    })

    const first = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    const { snapshotId: s1 } = await ingestParquetVersion(first.session, {
      table: 'res_t',
      parquetUrl: v1,
    })
    const k1 = lakeCatalogKey(RESOURCE, first.generation)
    await first.publish(k1)

    const second = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: k1 })
    const { snapshotId: s2 } = await ingestParquetVersion(second.session, {
      table: 'res_t',
      parquetUrl: v2,
      key: ['id'],
    })
    const k2 = lakeCatalogKey(RESOURCE, second.generation)
    await second.publish(k2)

    const diff = await withLakeCatalogReader(config, store, { catalogKey: k2 }, (session) =>
      diffVersions(session, { table: 'res_t', fromSnapshot: s1, toSnapshot: s2, key: ['id'] })
    )
    expect(diff).toMatchObject({ keyed: true, addedRows: 1, removedRows: 1, changedRows: 1 })
  })

  it("name every file each snapshot reads, as found under the generation's data path", async () => {
    const { store } = memoryStore()
    const v1 = join(root, 'v1.parquet')
    const v2 = join(root, 'v2.parquet')
    await withBucketSession(config, async (session) => {
      await session.run(
        `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(id, name)) TO '${v1}' (FORMAT parquet)`
      )
      await session.run(
        `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'B')) t(id, name)) TO '${v2}' (FORMAT parquet)`
      )
    })
    const draft = await openLakeCatalogDraft(config, store, { resourceId: RESOURCE, from: null })
    await ingestParquetVersion(draft.session, { table: 'res_t', parquetUrl: v1 })
    // Keyed, so the change is a delete file beside a new data file
    await ingestParquetVersion(draft.session, { table: 'res_t', parquetUrl: v2, key: ['id'] })
    const key = lakeCatalogKey(RESOURCE, draft.generation)
    await draft.publish(key)

    const named = await withLakeCatalogReader(config, store, { catalogKey: key }, (session) =>
      lakeCatalogFileNames(session)
    )
    const found = (
      await readdir(join(root, lakeDataPrefix(RESOURCE, draft.generation)), { recursive: true })
    )
      .filter((path) => path.endsWith('.parquet'))
      .map((path) => path.split('/').pop())
    expect(named.some((name) => name.endsWith('-delete.parquet'))).toBe(true)
    expect([...named].sort()).toEqual([...found].sort())
  })
})
