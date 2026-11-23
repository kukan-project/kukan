/**
 * An Excel version through Interpret and layer 2, for real (ADR-057, Excel-tables
 * spec §7.1): the heavy process reads the workbook, DuckDB writes the table and
 * loads it into the resource's catalog, data files in a local directory standing
 * in for the bucket, and the test database records what was made of the version.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import {
  closeLakeInstances,
  lakeTableName,
  withLakeCatalogReader,
  type LakeConfig,
} from '@kukan/lake'
import { PostgresJobQueue } from '@kukan/queue'
import { createLogger, getStorageKey } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { currentLakeCatalog } from '@kukan/api/services/lake/lake-catalog'
import { pendingLakeVersionSource } from '@kukan/api/services/resource-version-service'
import { buildPipelineContext } from '../../pipeline/run/build-context'
import { executeInterpret } from '../../pipeline/steps/interpret'
import { executeLake } from '../../pipeline/steps/lake'
import { retryLakeIngest } from '../../pipeline/retry-lake-ingest'
import type { PipelineContext } from '../../pipeline/run/types'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'
import { xlsxBuffer } from '../test-helpers/xlsx'

const db = getTestDb()
const HASH = 'sha256:workbook'

let root: string
let lake: LakeConfig
let packageId: string
let resourceId: string
let objects: Map<string, Buffer>

/** The bucket: objects in a map, the lake's data files where DuckDB wrote them under `root`. */
function storage(): StorageAdapter {
  return {
    download: async (key: string) => {
      const bytes = objects.get(key)
      if (!bytes) throw new Error(`NoSuchKey: ${key}`)
      return Readable.from([bytes])
    },
    head: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.length } : null
    },
    upload: async (key: string, body: Buffer | Readable) => {
      const chunks: Buffer[] = []
      for await (const chunk of Readable.from(body)) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks))
    },
    list: async (prefix: string) => {
      const files = await readdir(join(root, prefix), { recursive: true }).catch(() => [])
      return {
        objects: [...objects.keys(), ...files.map((f) => `${prefix}${f}`)]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, lastModified: new Date() })),
      }
    },
    deleteMany: async (keys: string[]) => {
      for (const key of keys) objects.delete(key)
      return keys
    },
  } as unknown as StorageAdapter
}

function context(withLake = true): PipelineContext {
  return buildPipelineContext(
    db,
    storage(),
    undefined,
    withLake ? { config: lake, queue: new PostgresJobQueue({ db }) } : undefined
  )
}

/** A workbook under a title: one sheet of codes stored as strings, names and counts. */
async function plainWorkbook(): Promise<Buffer> {
  return xlsxBuffer({
    shared: ['<si><t>施設の一覧</t></si>', '<si><t>コード</t></si>', '<si><t>名称</t></si>'],
    sheets: {
      1: [
        [{ s: 0 }],
        [{ s: 1 }, { s: 2 }, { inline: '人数' }],
        ...Array.from({ length: 12 }, (_, i) => [
          { inline: `00${i + 1}` },
          { inline: `施設${i + 1}` },
          i * 10,
        ]),
      ],
    },
  })
}

/** Two sheets of a table each: not one to read by rule. */
async function twoSheetWorkbook(): Promise<Buffer> {
  const sheet = (name: string) => [
    [{ inline: `${name}名` }, { inline: '値' }],
    ...Array.from({ length: 12 }, (_, i) => [{ inline: `${name}${i}` }, i]),
  ]
  return xlsxBuffer({ sheets: { 1: sheet('a'), 2: sheet('b') }, tabs: [1, 2] })
}

async function uploadVersion(file: Buffer) {
  const storageKey = getStorageKey(packageId, resourceId, 'v1')
  objects.set(storageKey, file)
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    storageKey,
    size: file.length,
    hash: HASH,
    origin: 'upload',
    state: 'active',
    format: 'XLSX',
  })
  return { storageKey, size: file.length }
}

/** Interpret, loading layer 2 from the table as the run does, and record what was made. */
async function interpret(ctx: PipelineContext, source: { storageKey: string; size: number }) {
  const result = await executeInterpret(resourceId, packageId, source, 'XLSX', ctx, {
    onTable: async (sourcePath) => {
      const lakeResult = await executeLake({ resourceId, sourcePath, contentHash: HASH }, ctx)
      if (lakeResult.status === 'failed') throw lakeResult.error
    },
  })
  if (result?.schema) {
    await ctx.recordVersionSchema({
      resourceId,
      version: 1,
      schema: result.schema,
      noTableReason: result.reason,
      readingProposal: result.readingProposal,
    })
  }
  return result
}

async function versionRow() {
  const [row] = await db
    .select()
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
  return row
}

async function lakeRows(): Promise<Record<string, unknown>[]> {
  const catalogKey = (await currentLakeCatalog(db, resourceId))!
  return withLakeCatalogReader(lake, storage(), { catalogKey }, (session) =>
    session.rows(`SELECT * FROM ${session.catalog}.${lakeTableName(resourceId)} ORDER BY "コード"`)
  )
}

beforeEach(async () => {
  await cleanDatabase()
  objects = new Map()
  root = await mkdtemp(join(tmpdir(), 'excel-table-'))
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
    INSERT INTO package (name, state) VALUES ('test-pkg-excel', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload', format: 'XLSX' })
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

describe('an uploaded Excel workbook', { timeout: 30_000 }, () => {
  it('that is a plain table ends with a schema, a preview, and its rows in layer 2', async () => {
    const result = await interpret(context(), await uploadVersion(await plainWorkbook()))

    // The preview and its profile, beside the text the index reads
    expect(objects.has(result!.previewKey!)).toBe(true)
    expect(result!.previewKey).toMatch(/\.parquet$/)
    expect(result!.documentText!.bytes).toBeGreaterThan(0)

    const row = await versionRow()
    expect(row.schema?.rowCount).toBe(12)
    expect(row.schema?.columns.map((c) => [c.name, c.type])).toEqual([
      ['コード', 'string'],
      ['名称', 'string'],
      ['人数', 'integer'],
    ])
    expect(row.noTableReason).toBeNull()
    expect(row.readingProposal).toBeNull()
    expect(row.lakeSnapshotId).not.toBeNull()

    const rows = await lakeRows()
    expect(rows).toHaveLength(12)
    expect(rows[0]).toMatchObject({ コード: '001', 名称: '施設1' })
  })

  it('that is not ends with no table, the first reason, and every reason as a proposal', async () => {
    const result = await interpret(context(), await uploadVersion(await twoSheetWorkbook()))

    expect(result!.previewKey).toBeNull()
    const row = await versionRow()
    expect(row.schema).toEqual({ rowCount: 0, columns: [] })
    expect(row.noTableReason).toBe('multiple-sheets')
    expect(row.readingProposal).toEqual({ reasons: ['multiple-sheets'] })
    expect(row.lakeSnapshotId).toBeNull()
    // Nothing for the hourly sweep to hand out
    expect(await pendingLakeVersionSource(db, { resourceId, version: 1 })).toBeNull()
  })

  it('clears the proposal when a later reading of the version finds a table', async () => {
    const source = await uploadVersion(await plainWorkbook())
    await db
      .update(resourceVersion)
      .set({
        schema: { rowCount: 0, columns: [] },
        noTableReason: 'multiple-sheets',
        readingProposal: { reasons: ['multiple-sheets'] },
      })
      .where(eq(resourceVersion.resourceId, resourceId))

    await interpret(context(), source)

    const row = await versionRow()
    expect(row.noTableReason).toBeNull()
    expect(row.readingProposal).toBeNull()
  })

  it('stored before workbooks were read as tables, is read and loaded by the sweep', async () => {
    const source = await uploadVersion(await plainWorkbook())
    // Never interpreted: a version stored before this reading existed (spec §7.2)
    expect(await pendingLakeVersionSource(db, { resourceId, version: 1 })).toMatchObject({
      storageKey: source.storageKey,
    })

    const queue = new PostgresJobQueue({ db })
    await retryLakeIngest(
      { resourceId, version: 1 },
      { ctx: context(), db, queue, log: createLogger({ name: 'test' }) }
    )

    const row = await versionRow()
    expect(row.schema?.columns.length).toBeGreaterThan(0)
    expect(row.lakeSnapshotId).not.toBeNull()
    expect(await lakeRows()).toHaveLength(12)
  })

  it('stored before and not a plain table, is settled by the sweep and leaves it', async () => {
    await uploadVersion(await twoSheetWorkbook())

    const queue = new PostgresJobQueue({ db })
    await retryLakeIngest(
      { resourceId, version: 1 },
      { ctx: context(), db, queue, log: createLogger({ name: 'test' }) }
    )

    const row = await versionRow()
    expect(row.noTableReason).toBe('multiple-sheets')
    expect(row.schema?.columns).toEqual([])
    expect(await pendingLakeVersionSource(db, { resourceId, version: 1 })).toBeNull()
  })
})
