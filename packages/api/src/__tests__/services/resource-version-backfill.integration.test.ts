/**
 * Integration tests for the one-time version backfill (ADR-043): snapshot each
 * unversioned resource's live file as v1 without re-fetching/re-indexing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { resource, resourceVersion, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { Readable } from 'node:stream'
import { getStorageKey, getVersionKey } from '@kukan/shared'
import { hashBuffer } from '@kukan/shared/hash-node'
import { randomUUID } from 'node:crypto'
import { ResourceVersionService } from '../../services/resource-version-service'
import { CLAIM_STALE_AFTER_MS, claimResources } from '../../services/pipeline-claim'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string

/** Bytes each storage key holds, so the post-copy verification has something real to hash. */
const objects = new Map<string, Buffer>()

function mockStorage(overrides: Record<string, unknown> = {}) {
  return {
    copy: vi.fn(async (src: string, dest: string) => {
      const body = objects.get(src)
      if (!body) throw new Error(`missing object: ${src}`)
      objects.set(dest, body)
    }),
    download: vi.fn(async (key: string) => {
      const body = objects.get(key)
      if (!body) throw new Error(`missing object: ${key}`)
      return Readable.from(body)
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key)
    }),
    ...overrides,
  } as never
}

/**
 * @param hash - the hash the row records. Defaults to the real hash of the
 *   stored bytes; pass a different one to model the live object having been
 *   replaced since the row was written.
 */
async function addResource(opts: {
  name: string
  hash?: string | null
  content?: string
  urlType?: string
  size?: number
}): Promise<string> {
  const body = Buffer.from(opts.content ?? `content of ${opts.name}`)
  const [r] = await db
    .insert(resource)
    .values({
      packageId,
      name: opts.name,
      hash: opts.hash === undefined ? hashBuffer(body) : opts.hash,
      size: opts.size ?? 10,
      urlType: opts.urlType ?? 'upload',
    })
    .returning()
  const key = getStorageKey(packageId, r.id, 'run')
  await db.update(resource).set({ storageKey: key }).where(eq(resource.id, r.id))
  objects.set(key, body)
  return r.id
}

beforeEach(async () => {
  objects.clear()
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-backfill', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

/**
 * A resource whose preview records the hash of the bytes it was built from —
 * the proof the backfill requires before attaching it to a version.
 */
async function addTabularResource(
  name: string,
  versions: {
    version: number
    snapshotId?: number | null
    state?: string
    lakeSourceKey?: string
  }[],
  opts: {
    previewKey?: string
    sourceHash?: string | null
    liveHash?: string
    status?: string
    extractStatus?: string
  } = {}
): Promise<void> {
  const top = Math.max(...versions.map((v) => v.version))
  const id = await addResource({ name, hash: opts.liveHash ?? `sha256:v${top}` })
  const sourceHash = opts.sourceHash === undefined ? `sha256:v${top}` : opts.sourceHash
  const [pipeline] = await db
    .insert(resourcePipeline)
    .values({
      resourceId: id,
      status: opts.status ?? 'complete',
      previewKey: opts.previewKey ?? `preview/${packageId}/x.parquet`,
      metadata: sourceHash === null ? {} : { sourceHash },
    })
    .returning()
  await db.insert(resourcePipelineStep).values({
    pipelineId: pipeline.id,
    stepName: 'extract',
    status: opts.extractStatus ?? 'complete',
  })
  for (const v of versions) {
    await db.insert(resourceVersion).values({
      resourceId: id,
      version: v.version,
      storageKey: getVersionKey(packageId, id, v.version, 'v'),
      size: 10,
      hash: `sha256:v${v.version}`,
      origin: 'upload',
      state: v.state ?? 'active',
      ducklakeSnapshotId: v.snapshotId ?? null,
      lakeSourceKey: v.lakeSourceKey ?? null,
    })
  }
}

describe('countUnversioned', () => {
  it('counts active resources with content and no version', async () => {
    await addResource({ name: 'a' })
    await addResource({ name: 'b' })
    await addResource({ name: 'no-content', hash: null }) // never fetched → excluded

    expect(await service.countUnversioned()).toBe(2)
  })

  it('excludes resources that already have a version', async () => {
    const id = await addResource({ name: 'a' })
    await db.insert(resourceVersion).values({
      resourceId: id,
      version: 1,
      storageKey: getVersionKey(packageId, id, 1, 'v'),
      hash: 'sha256:a',
      origin: 'upload',
    })
    expect(await service.countUnversioned()).toBe(0)
  })
})

describe('backfillVersions', () => {
  it('writes a key of its own attempt, so a retry cannot land on one being swept', async () => {
    // The orphan sweep decides what to delete from a list it read moments
    // earlier. Derived from the version number alone, a capture that failed and
    // is retried would reserve, copy and record that same key — and have its
    // object deleted with the row already pointing at it (ADR-045 §3).
    const id = await addResource({ name: 'a' })

    await service.backfillVersions({ storage: mockStorage() })

    const [captured] = await db
      .select({ storageKey: resourceVersion.storageKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))
    expect(captured.storageKey).toMatch(
      new RegExp(`^versions/${packageId}/${id}/v1\\.[0-9a-f-]{36}$`)
    )
  })

  it('snapshots the live key as v1 by server-side copy, no re-fetch', async () => {
    const uploadId = await addResource({ name: 'up', urlType: 'upload' })
    const urlId = await addResource({ name: 'ext', urlType: 'external' })
    const storage = mockStorage()

    const result = await service.backfillVersions({ storage })

    // No lake config supplied, so the layer-2 pass is a no-op.
    expect(result).toEqual({ backfilled: 2, skipped: 0, failed: 0, ingested: 0, ingestFailed: 0 })
    // Copies from the live key to v1 — never a network fetch. The destination
    // carries a per-attempt token (ADR-043), so it is matched by shape.
    expect((storage as { copy: ReturnType<typeof vi.fn> }).copy).toHaveBeenCalledWith(
      getStorageKey(packageId, uploadId, 'run'),
      expect.stringMatching(new RegExp(`^versions/${packageId}/${uploadId}/v1\\.[0-9a-f-]{36}$`))
    )

    const upVer = await service.getVersion(uploadId, 1)
    expect(upVer.version).toBe(1)
    expect(upVer.origin).toBe('upload')
    const urlVer = await service.getVersion(urlId, 1)
    expect(urlVer.origin).toBe('fetch') // external URL → observed at fetch time

    // Nothing left to do.
    expect(await service.countUnversioned()).toBe(0)
  })

  it('leaves a resource alone while its pipeline is in flight', async () => {
    // That run captures v1 itself; counting it here would misreport how much
    // migration work is left.
    const id = await addResource({ name: 'a' })
    await db.insert(resourcePipeline).values({ resourceId: id, status: 'processing' })
    const storage = mockStorage()

    const result = await service.backfillVersions({ storage })

    expect(result.backfilled).toBe(0)
    expect(await service.countUnversioned()).toBe(0)
  })

  it('skips a resource something else is holding', async () => {
    // A purge holds the claim without moving the pipeline's status, so the
    // status filter above does not see it. The migration steps aside and the
    // next run of the job picks the resource up — and once the capture lock
    // goes (ADR-044 §5), this claim is the only thing keeping the two apart.
    const id = await addResource({ name: 'a' })
    await db.insert(resourcePipeline).values({ resourceId: id, status: 'complete' })
    await claimResources(db, [id], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
    const storage = mockStorage()

    const result = await service.backfillVersions({ storage })

    expect(result).toMatchObject({ backfilled: 0, skipped: 1, failed: 0 })
    expect((storage as { copy: ReturnType<typeof vi.fn> }).copy).not.toHaveBeenCalled()
    expect(await service.countUnversioned()).toBe(1)
  })

  it('is idempotent — a second run does nothing', async () => {
    await addResource({ name: 'a' })
    const storage = mockStorage()

    const first = await service.backfillVersions({ storage })
    expect(first.backfilled).toBe(1)
    const second = await service.backfillVersions({ storage })
    expect(second).toEqual({ backfilled: 0, skipped: 0, failed: 0, ingested: 0, ingestFailed: 0 })
  })

  it('completes with more resources in flight than the pool has connections', async () => {
    // Each capture holds an advisory lock for its whole transaction. If any query
    // inside reached back to the pool, the chunk would deadlock: BACKFILL_CONCURRENCY
    // locks are held at once and the test pool has 5 connections.
    for (let i = 0; i < 12; i++) await addResource({ name: `r${i}` })
    const storage = mockStorage()

    const result = await service.backfillVersions({ storage })

    expect(result).toEqual({ backfilled: 12, skipped: 0, failed: 0, ingested: 0, ingestFailed: 0 })
    expect(await service.countUnversioned()).toBe(0)
  }, 30_000)

  // upload-complete has always accepted any string as `hash`, so pre-existing
  // rows may carry something that was never a SHA-256. Refusing those would
  // leave the migration permanently incomplete, so the file wins and the row is
  // normalized to it.
  it('normalizes a stored hash that is not the real one, rather than skipping forever', async () => {
    const id = await addResource({ name: 'a', content: 'original', hash: 'not-a-real-hash' })
    const storage = mockStorage()

    const result = await service.backfillVersions({ storage })

    expect(result).toMatchObject({ backfilled: 1, skipped: 0, failed: 0 })
    const [row] = await db.select({ hash: resource.hash }).from(resource).where(eq(resource.id, id))
    expect(row.hash).toBe(hashBuffer(Buffer.from('original')))
    const version = await service.getVersion(id, 1)
    expect(version.hash).toBe(row.hash)
    expect(await service.countUnversioned()).toBe(0)
  })

  it('leaves the row describing newer content when a run publishes mid-capture', async () => {
    // The copy takes a key nothing rewrites, so v1 still holds the bytes this
    // row described — that is real history. What must not happen is the row
    // being normalized back to it: `hash` now describes the newer object, and
    // the run that published it owns that.
    const id = await addResource({ name: 'a', content: 'original', hash: 'sha256:stale' })
    const storage = mockStorage()
    const realCopy = (storage as { copy: (s: string, d: string) => Promise<void> }).copy
    ;(storage as { copy: unknown }).copy = vi.fn(async (src: string, dest: string) => {
      const newerKey = getStorageKey(packageId, id, 'newer')
      objects.set(newerKey, Buffer.from('published by a pipeline run'))
      await db
        .update(resource)
        .set({ storageKey: newerKey, hash: 'sha256:newer' })
        .where(eq(resource.id, id))
      await realCopy(src, dest)
    })

    const result = await service.backfillVersions({ storage })

    expect(result).toMatchObject({ backfilled: 1, skipped: 0, failed: 0 })
    // The key carries a per-attempt token, so it is read back off the row.
    // (The view omits storage pointers — no response carries them, ADR-043.)
    const [captured] = await db
      .select({ storageKey: resourceVersion.storageKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))
    expect(objects.get(captured.storageKey)?.toString()).toBe('original')
    const [row] = await db.select().from(resource).where(eq(resource.id, id))
    expect(row.hash).toBe('sha256:newer')
  })

  it('counts a copy failure and keeps going', async () => {
    await addResource({ name: 'ok' })
    await addResource({ name: 'bad' })
    // Fail one copy, succeed the rest.
    const storage = mockStorage()
    const realCopy = (storage as { copy: (s: string, d: string) => Promise<void> }).copy
    ;(storage as { copy: unknown }).copy = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing object'))
      .mockImplementation(realCopy)

    const result = await service.backfillVersions({ storage })
    expect(result.backfilled).toBe(1)
    expect(result.failed).toBe(1)
  })
})

describe('countPendingLakeIngest', () => {
  it('counts a tabular current version that has no snapshot', async () => {
    await addTabularResource('a', [{ version: 1 }])

    expect(await service.countPendingLakeIngest()).toBe(1)
  })

  it('ignores versions already in the lake', async () => {
    await addTabularResource('a', [{ version: 1, snapshotId: 7 }])

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('counts only the latest version, not the older ones', async () => {
    // v1 has no snapshot but is not current; only v2 is eligible.
    await addTabularResource('a', [{ version: 1 }, { version: 2 }])

    expect(await service.countPendingLakeIngest()).toBe(1)
  })

  it('ignores resources with no Parquet preview (non-tabular)', async () => {
    await addTabularResource('a', [{ version: 1 }], {
      previewKey: `preview/${packageId}/x.txt`,
    })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('ignores a preview built from different bytes than the version holds', async () => {
    // e.g. the file was replaced and the pipeline is still queued, so the
    // preview is the one an earlier run produced.
    await addTabularResource('a', [{ version: 1 }], { sourceHash: 'sha256:an-older-file' })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  // Previews written before the source hash existed are what this migration is
  // for, so they fall back to "settled pipeline + version is the live content".
  it('counts a pre-existing preview with no source hash once the pipeline is settled', async () => {
    await addTabularResource('a', [{ version: 1 }], { sourceHash: null })

    expect(await service.countPendingLakeIngest()).toBe(1)
  })

  it('ignores a pre-existing preview whose run failed to Extract', async () => {
    // A failed Extract keeps the previous preview and does not fail the run, so
    // status alone would let the old Parquet be recorded against the new version.
    await addTabularResource('a', [{ version: 1 }], { sourceHash: null, extractStatus: 'error' })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('ignores a pre-existing preview while a newer file is still queued', async () => {
    await addTabularResource('a', [{ version: 1 }], { sourceHash: null, status: 'queued' })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('ignores a pre-existing preview when the version is not the live content', async () => {
    await addTabularResource('a', [{ version: 1 }], {
      sourceHash: null,
      liveHash: 'sha256:a-newer-file',
    })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('ignores purged versions', async () => {
    await addTabularResource('a', [{ version: 1, state: 'purged' }])

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('counts a mid-history version that names the Parquet it needs', async () => {
    // The case the current preview cannot answer for: v1's ingest was deferred
    // and v2 has since replaced the preview. Before the version carried the
    // pointer, only the retry's queue message knew — and once that was gone the
    // version was unreachable from the database (ADR-043 §6-6, kukan#204).
    await addTabularResource('a', [
      { version: 1, lakeSourceKey: 'preview/v1.parquet' },
      { version: 2, snapshotId: 7 },
    ])

    expect(await service.countPendingLakeIngest()).toBe(1)
  })
})

describe('ingestPendingIntoLake', () => {
  // The standing repair for a version the queue never delivered: the pipeline's
  // Lake step failed, its retry could not be enqueued, and the original message
  // was deleted with the run. The intent survives as an active version with no
  // snapshot id — which is `pendingLakeIngestQuery`, the same predicate the
  // countPendingLakeIngest cases above pin down. What is left to check here is
  // that an idle sweep costs nothing, since it now runs hourly on every worker.

  it('opens no lake session when there is nothing pending', async () => {
    // Runs hourly on every worker, and most hours have nothing to do. An
    // unreachable catalog stands in for the cost: reaching it would throw.
    await addResource({ name: 'a' })

    expect(await service.ingestPendingIntoLake(unreachableLake)).toEqual({
      ingested: 0,
      ingestFailed: 0,
    })
  })

  it('does nothing without a lake configured', async () => {
    expect(await service.ingestPendingIntoLake(undefined)).toEqual({
      ingested: 0,
      ingestFailed: 0,
    })
  })
})
