/**
 * Integration tests for the question a run asks before deriving anything again.
 *
 * A run that created no version is looking at content that is already here, and
 * the version file it would read is immutable (ADR-046) — so the work only has
 * to be done if some part of it never landed. What "never landed" means is read
 * off the row and off the lake's own pending predicate, which is why this is
 * tested against a database rather than against a stub of it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { LakeConfig } from '@kukan/lake'
import { getStorageKey } from '@kukan/shared'
import { buildPipelineContext } from '../../../pipeline/run/build-context'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()
const storage = {} as StorageAdapter
/** Never connected to: every case here is decided before an ingest is attempted. */
const lake = { catalog: 'test', dataPath: 's3://bucket/lake' } as unknown as LakeConfig

const HASH = 'sha256:same'
const PREVIEW_KEY = 'previews/pkg/res.tok.parquet'

let resourceId: string
let packageId: string

/** What a finished run leaves on the row: a preview of these bytes, indexed. */
async function rowSays(metadata: Record<string, unknown>, previewKey: string | null = PREVIEW_KEY) {
  await db
    .update(resourcePipeline)
    .set({ previewKey, metadata })
    .where(sql`${resourcePipeline.resourceId} = ${resourceId}`)
}

/** A version of these bytes, ingested into the lake unless told otherwise. */
async function versionExists(opts: { format?: string; snapshot?: number | null } = {}) {
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    storageKey: getStorageKey(packageId, resourceId, 'v1'),
    origin: 'upload',
    state: 'active',
    hash: HASH,
    size: 10,
    format: opts.format ?? 'CSV',
    schema: {
      columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
      rowCount: 1,
    },
    ducklakeSnapshotId: opts.snapshot === undefined ? 7 : opts.snapshot,
  })
}

function ask(withLake = true) {
  return buildPipelineContext(
    db,
    storage,
    undefined,
    withLake ? lake : undefined
  ).derivativesDescribe(resourceId, HASH, 1)
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-derived', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({
      packageId,
      name: 'r',
      urlType: 'upload',
      storageKey: 'resources/pkg/res.tok',
      hash: HASH,
      format: 'CSV',
    })
    .returning()
  resourceId = res.id
  await db.insert(resourcePipeline).values({ resourceId })
})

afterAll(async () => {
  await closeTestDb()
})

describe('derivativesDescribe', () => {
  it('accounts for the bytes when every derivative landed', async () => {
    await versionExists()
    await rowSays({ sourceHash: HASH, contentIndexed: true })

    expect(await ask()).toBe(true)
  })

  it('does not, when the interpretation left no preview', async () => {
    await versionExists()
    await rowSays({ sourceHash: HASH, contentIndexed: true }, null)

    expect(await ask()).toBe(false)
  })

  it('accounts for the bytes of a document by the text it was read into', async () => {
    // A document has no preview; its text artifact is what it was interpreted
    // into, and reading it again would only write the same one
    await versionExists({ format: 'PDF', snapshot: null })
    await rowSays(
      {
        sourceHash: HASH,
        contentIndexed: true,
        documentTextKey: 'previews/p/r.tok.text.ndjson.zst',
      },
      null
    )

    expect(await ask()).toBe(true)
  })

  it('does not, when the preview describes content since replaced', async () => {
    await versionExists()
    await rowSays({ sourceHash: 'sha256:older', contentIndexed: true })

    expect(await ask()).toBe(false)
  })

  it('does not, when the interpretation was made for another version of the bytes', async () => {
    // A label corrected over the same bytes, its run cut short: the retry must
    // read them as the new version rather than take the old one's as its own
    await versionExists()
    await rowSays({ sourceHash: HASH, contentIndexed: true, sourceVersion: 0 })

    expect(await ask()).toBe(false)
  })

  it('does not, when the content was never indexed', async () => {
    // What a run under a draft package leaves behind (ADR-039): the publish
    // that follows is the one that indexes, and it must not be skipped
    await versionExists()
    await rowSays({ sourceHash: HASH, contentIndexed: false })

    expect(await ask()).toBe(false)
  })

  it('does not, when the table never reached the lake', async () => {
    await versionExists({ snapshot: null })
    await rowSays({ sourceHash: HASH, contentIndexed: true })

    expect(await ask()).toBe(false)
  })

  it('accounts for the bytes of a format the lake never loads', async () => {
    // A ZIP has a preview (its manifest) and no snapshot, forever. Read as a
    // pending ingest it would re-extract the archive on every upload of it.
    await versionExists({ format: 'ZIP', snapshot: null })
    await rowSays({ sourceHash: HASH, contentIndexed: true })

    expect(await ask()).toBe(true)
  })

  it('accounts for the bytes where there is no lake to load them into', async () => {
    await versionExists({ snapshot: null })
    await rowSays({ sourceHash: HASH, contentIndexed: true })

    expect(await ask(false)).toBe(true)
  })
})

describe('storedInterpretation', () => {
  const stored = (version = 1) =>
    buildPipelineContext(db, storage, undefined, undefined).storedInterpretation(
      resourceId,
      HASH,
      version
    )

  it('gives back what interpreting these bytes left, whether or not it was indexed', async () => {
    const profile = { columns: [], key: 'previews/pkg/res.tok.profile.ndjson.zst' }
    await rowSays({ sourceHash: HASH, encoding: 'Shift_JIS', contentIndexed: false })
    await db
      .update(resourcePipeline)
      .set({ profile: profile as never })
      .where(sql`${resourcePipeline.resourceId} = ${resourceId}`)

    expect(await stored()).toEqual({ previewKey: PREVIEW_KEY, encoding: 'Shift_JIS', profile })
  })

  it("gives back a document's text, which has no preview", async () => {
    await rowSays(
      { sourceHash: HASH, documentTextKey: 'previews/pkg/text.ndjson.zst', documentTextBytes: 0 },
      null
    )

    expect(await stored()).toEqual({
      previewKey: null,
      documentText: { key: 'previews/pkg/text.ndjson.zst', bytes: 0 },
    })
  })

  it('gives back how a text file was read, which leaves nothing else', async () => {
    await rowSays({ sourceHash: HASH, encoding: 'EUC-JP' }, null)

    expect(await stored()).toEqual({ previewKey: null, encoding: 'EUC-JP' })
  })

  it('gives nothing back for a table read before its profile was kept', async () => {
    await rowSays({
      sourceHash: HASH,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
    })

    expect(await stored()).toBeNull()
  })

  it('gives back how a CSV that made no table was read', async () => {
    // Too wide, or short of memory: interpreted, with nothing to profile
    await rowSays(
      { sourceHash: HASH, encoding: 'UTF8', schema: { columns: [], rowCount: 0 } },
      null
    )

    expect(await stored()).toEqual({ previewKey: null, encoding: 'UTF8' })
  })

  it('gives back an interpretation made for this version, and nothing for another', async () => {
    // The same bytes can be another version: read as another format, or keyed
    // another way
    await rowSays({ sourceHash: HASH, encoding: 'UTF8', sourceVersion: 1 }, null)

    expect(await stored(1)).toEqual({ previewKey: null, encoding: 'UTF8' })
    expect(await stored(2)).toBeNull()
  })

  it('gives nothing back for other bytes', async () => {
    await rowSays({ sourceHash: 'sha256:other' })

    expect(await stored()).toBeNull()
  })

  it('gives nothing back where the interpretation left nothing to index from', async () => {
    // A text head kept before `documentTextBytes` is not a text artifact
    await rowSays({ sourceHash: HASH, documentTextKey: 'previews/pkg/head.txt' }, null)

    expect(await stored()).toBeNull()
  })
})
