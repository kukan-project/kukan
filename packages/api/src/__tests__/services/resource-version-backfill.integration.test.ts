/**
 * Integration tests for the one-time version backfill (ADR-043): snapshot each
 * unversioned resource's live file as v1 without re-fetching/re-indexing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { resource, resourceVersion, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { Readable } from 'node:stream'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { getStorageKey, getVersionKey, MAX_PARQUET_SOURCE_SIZE } from '@kukan/shared'
import { hashBuffer } from '@kukan/shared/hash-node'
import { randomUUID } from 'node:crypto'
import { ResourceVersionService } from '../../services/resource-version-service'
import { CLAIM_STALE_AFTER_MS, claimResources } from '../../services/pipeline-claim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string

/** Bytes each storage key holds, so the post-copy verification has something real to hash. */
const objects = new Map<string, Buffer>()

/** The backfill hands pending versions to the worker rather than loading them
 *  itself (ADR-046), so it needs somewhere to put them. */
function mockQueue() {
  return { enqueue: vi.fn(), getStats: vi.fn(), process: vi.fn(), stop: vi.fn() } as QueueAdapter
}

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
  format?: string
}): Promise<string> {
  const body = Buffer.from(opts.content ?? `content of ${opts.name}`)
  const [r] = await db
    .insert(resource)
    .values({
      packageId,
      name: opts.name,
      hash: opts.hash === undefined ? hashBuffer(body) : opts.hash,
      size: opts.size ?? 10,
      format: opts.format ?? null,
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
    size?: number
    /** Defaults to the resource's, the way a version records it (ADR-046). */
    format?: string
  }[],
  opts: {
    previewKey?: string
    sourceHash?: string | null
    liveHash?: string
    status?: string
    extractStatus?: string
    format?: string
  } = {}
): Promise<void> {
  const top = Math.max(...versions.map((v) => v.version))
  const format = opts.format ?? 'CSV'
  const id = await addResource({ name, hash: opts.liveHash ?? `sha256:v${top}`, format })
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
    // The retired name on purpose: the fallback this exercises only applies to
    // previews from before `sourceHash` existed, all of which predate the
    // rename to `interpret` (ADR-046).
    stepName: 'extract',
    status: opts.extractStatus ?? 'complete',
  })
  for (const v of versions) {
    await db.insert(resourceVersion).values({
      resourceId: id,
      version: v.version,
      storageKey: getVersionKey(packageId, id, v.version, 'v'),
      size: v.size ?? 10,
      hash: `sha256:v${v.version}`,
      origin: 'upload',
      state: v.state ?? 'active',
      format: v.format ?? format,
      ducklakeSnapshotId: v.snapshotId ?? null,
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

describe('createFirstVersions', () => {
  it('writes a key of its own attempt, so a retry cannot land on one being swept', async () => {
    // The orphan sweep decides what to delete from a list it read moments
    // earlier. Derived from the version number alone, a creation that failed and
    // is retried would reserve, copy and record that same key — and have its
    // object deleted with the row already pointing at it (ADR-045 §3).
    const id = await addResource({ name: 'a' })

    await service.createFirstVersions({ storage: mockStorage(), queue: mockQueue() })

    const [created] = await db
      .select({ storageKey: resourceVersion.storageKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))
    expect(created.storageKey).toMatch(
      new RegExp(`^versions/${packageId}/${id}/v1\\.[0-9a-f-]{36}$`)
    )
  })

  it('snapshots the live key as v1 by server-side copy, no re-fetch', async () => {
    const uploadId = await addResource({ name: 'up', urlType: 'upload' })
    const urlId = await addResource({ name: 'ext', urlType: 'external' })
    const storage = mockStorage()

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    // Uploads with no format, so nothing for layer 2 to interpret.
    expect(result).toEqual({ created: 2, skipped: 0, failed: 0, queued: 0, queueFailed: 0 })
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
    // That run creates v1 itself; counting it here would misreport how much
    // migration work is left.
    const id = await addResource({ name: 'a' })
    await db.insert(resourcePipeline).values({ resourceId: id, status: 'processing' })
    const storage = mockStorage()

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    expect(result.created).toBe(0)
    expect(await service.countUnversioned()).toBe(0)
  })

  it('skips a resource something else is holding', async () => {
    // A purge holds the claim without moving the pipeline's status, so the
    // status filter above does not see it. The migration steps aside and the
    // next run of the job picks the resource up — and once the version lock
    // goes (ADR-044 §5), this claim is the only thing keeping the two apart.
    const id = await addResource({ name: 'a' })
    await db.insert(resourcePipeline).values({ resourceId: id, status: 'complete' })
    await claimResources(db, [id], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
    const storage = mockStorage()

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    expect(result).toMatchObject({ created: 0, skipped: 1, failed: 0 })
    expect((storage as { copy: ReturnType<typeof vi.fn> }).copy).not.toHaveBeenCalled()
    expect(await service.countUnversioned()).toBe(1)
  })

  it('is idempotent — a second run does nothing', async () => {
    await addResource({ name: 'a' })
    const storage = mockStorage()

    const first = await service.createFirstVersions({ storage, queue: mockQueue() })
    expect(first.created).toBe(1)
    const second = await service.createFirstVersions({ storage, queue: mockQueue() })
    expect(second).toEqual({ created: 0, skipped: 0, failed: 0, queued: 0, queueFailed: 0 })
  })

  it('completes with more resources in flight than the pool has connections', async () => {
    // Each create holds an advisory lock for its whole transaction. If any query
    // inside reached back to the pool, the chunk would deadlock: FIRST_VERSION_CONCURRENCY
    // locks are held at once and the test pool has 5 connections.
    for (let i = 0; i < 12; i++) await addResource({ name: `r${i}` })
    const storage = mockStorage()

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    expect(result).toEqual({ created: 12, skipped: 0, failed: 0, queued: 0, queueFailed: 0 })
    expect(await service.countUnversioned()).toBe(0)
  }, 30_000)

  // upload-complete has always accepted any string as `hash`, so pre-existing
  // rows may carry something that was never a SHA-256. Refusing those would
  // leave the migration permanently incomplete, so the file wins and the row is
  // normalized to it.
  it('normalizes a stored hash that is not the real one, rather than skipping forever', async () => {
    const id = await addResource({ name: 'a', content: 'original', hash: 'not-a-real-hash' })
    const storage = mockStorage()

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    expect(result).toMatchObject({ created: 1, skipped: 0, failed: 0 })
    const [row] = await db.select({ hash: resource.hash }).from(resource).where(eq(resource.id, id))
    expect(row.hash).toBe(hashBuffer(Buffer.from('original')))
    const version = await service.getVersion(id, 1)
    expect(version.hash).toBe(row.hash)
    expect(await service.countUnversioned()).toBe(0)
  })

  it('leaves the row describing newer content when a run publishes mid-create', async () => {
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

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })

    expect(result).toMatchObject({ created: 1, skipped: 0, failed: 0 })
    // The key carries a per-attempt token, so it is read back off the row.
    // (The view omits storage pointers — no response carries them, ADR-043.)
    const [created] = await db
      .select({ storageKey: resourceVersion.storageKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))
    expect(objects.get(created.storageKey)?.toString()).toBe('original')
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

    const result = await service.createFirstVersions({ storage, queue: mockQueue() })
    expect(result.created).toBe(1)
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

  it('ignores a version a newer one has already overtaken', async () => {
    // Loading v1 now would leave the lake serving content the resource no
    // longer has; the ingest refuses it, so listing it would queue work that
    // can only be turned away (ADR-043).
    await addTabularResource('a', [{ version: 1 }, { version: 2, snapshotId: 7 }])

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('counts every un-ingested version, not just the latest', async () => {
    // What changed with ADR-046: the ingest reads the version file, which is
    // there for every version — so an older one that never made it in is real
    // outstanding work rather than something only the current preview could
    // have described.
    await addTabularResource('a', [{ version: 1 }, { version: 2 }])

    expect(await service.countPendingLakeIngest()).toBe(2)
  })

  it('ignores a resource layer 2 does not cover', async () => {
    // Nothing interprets a PDF, so its versions would sit here forever and be
    // re-enqueued every hour.
    await addTabularResource('a', [{ version: 1 }], { format: 'PDF' })

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('reads the format off the version, not the label the resource carries now', async () => {
    // Relabelling a resource must not decide what settled bytes are (ADR-046).
    // Both directions in one count: a version created as a PDF stays out under
    // a CSV label, and one created as a CSV stays in under a PDF label.
    await addTabularResource('now-labelled-csv', [{ version: 1, format: 'PDF' }])
    await addTabularResource('now-labelled-pdf', [{ version: 1, format: 'CSV' }], {
      format: 'PDF',
    })

    expect(await service.countPendingLakeIngest()).toBe(1)
  })

  it('ignores a version too large to interpret', async () => {
    await addTabularResource('a', [{ version: 1, size: MAX_PARQUET_SOURCE_SIZE + 1 }])

    expect(await service.countPendingLakeIngest()).toBe(0)
  })

  it('no longer asks anything of the preview', async () => {
    // The provenance proof this used to require — the preview's source hash
    // matching the version's — went with the preview being the input (ADR-046).
    await addTabularResource('a', [{ version: 1 }], { sourceHash: 'sha256:an-older-file' })

    expect(await service.countPendingLakeIngest()).toBe(1)
  })

  it('ignores purged versions', async () => {
    await addTabularResource('a', [{ version: 1, state: 'purged' }])

    expect(await service.countPendingLakeIngest()).toBe(0)
  })
})

describe('queuePendingLakeIngests', () => {
  // The standing repair for a version the queue never delivered: the pipeline's
  // Lake step failed, its retry could not be enqueued, and the original message
  // was deleted with the run. The intent survives as an active version with no
  // snapshot id — which is `pendingLakeIngestQuery`, the same predicate the
  // countPendingLakeIngest cases above pin down.

  it('enqueues nothing when nothing is pending', async () => {
    // Runs hourly on every worker task, and most hours have nothing to do.
    await addResource({ name: 'a' })
    const queue = mockQueue()

    expect(await service.queuePendingLakeIngests(queue)).toEqual({ queued: 0, failed: 0 })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('hands each outstanding version to the worker by id', async () => {
    // Ids only: what to read is settled by the version row, so a message that
    // disagreed with it would have nothing to act on (ADR-046).
    await addTabularResource('a', [{ version: 1, snapshotId: null }])
    const queue = mockQueue()

    expect(await service.queuePendingLakeIngests(queue)).toEqual({ queued: 1, failed: 0 })
    expect(queue.enqueue).toHaveBeenCalledWith('lake-ingest-version', {
      resourceId: expect.any(String),
      version: 1,
    })
  })
})
