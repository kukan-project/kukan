/**
 * Integration tests for the conversion of what the revert before ADR-044 §4
 * left behind: set-aside versions back to `active`, and whatever the resource
 * is serving issued as its newest version.
 *
 * The branches are all one question — who owns the live object — so each is
 * driven by arranging that ownership and reading back what the resource holds.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { resource, resourceVersion, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { Readable } from 'node:stream'
import { getStorageKey } from '@kukan/shared'
import type { VersionState } from '@kukan/shared'
import { hashBuffer } from '@kukan/shared/hash-node'
import { randomUUID } from 'node:crypto'
import { ResourceVersionService } from '../../services/resource-version-service'
import { CLAIM_STALE_AFTER_MS, claimResources } from '../../services/pipeline-claim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'
import { mapStorage } from '../test-helpers/fixtures'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string

/** Bytes each key holds, so a copy has something real to carry. */
const objects = new Map<string, Buffer>()

/** Issued versions are handed to the worker to load (ADR-046), so the pass
 *  needs somewhere to put them. */
function mockQueue() {
  return { enqueue: vi.fn(), getStats: vi.fn(), process: vi.fn(), stop: vi.fn() } as QueueAdapter
}

const mockStorage = (overrides: Record<string, unknown> = {}) =>
  mapStorage(objects, overrides) as unknown as StorageAdapter & { copy: ReturnType<typeof vi.fn> }

interface VersionSpec {
  version: number
  state?: VersionState
  content?: string
}

/**
 * A resource with versions, and a live pointer aimed wherever the caller says.
 *
 * @param live - the version whose object the pointer names, `{ unowned: n }`
 *   for a separate object holding version n's bytes that no version owns (what
 *   an unchanged re-fetch leaves), or `'none'` for a resource serving nothing.
 * @param rowSays - what to write on the resource row instead of the truth, for
 *   the pre-existing data whose recorded hash and size were never measured.
 */
async function addResource(opts: {
  name: string
  versions: VersionSpec[]
  live: number | { unowned: number } | 'none'
  state?: string
  sourceHash?: string | null
  schema?: unknown
  rowSays?: { hash: string | null; size: number | null }
}): Promise<string> {
  const [r] = await db
    .insert(resource)
    .values({
      packageId,
      name: opts.name,
      format: 'CSV',
      urlType: 'upload',
      state: opts.state ?? 'active',
    })
    .returning()

  const keys = new Map<number, string>()
  for (const v of opts.versions) {
    const key = getStorageKey(packageId, r.id, `v${v.version}`)
    const body = Buffer.from(v.content ?? `content of v${v.version}`)
    objects.set(key, body)
    keys.set(v.version, key)
    await db.insert(resourceVersion).values({
      resourceId: r.id,
      version: v.version,
      storageKey: key,
      size: body.length,
      hash: hashBuffer(body),
      origin: 'upload',
      state: v.state ?? 'active',
      format: 'CSV',
    })
  }

  if (opts.live !== 'none') {
    const live = opts.live
    const unowned = typeof live === 'object'
    const from = typeof live === 'object' ? live.unowned : live
    const body = objects.get(keys.get(from)!)!
    // An unowned live object is a key of its own holding some version's bytes:
    // a re-fetch writes a fresh key every time, and the gate then declines to
    // make a version of it.
    const key = unowned ? getStorageKey(packageId, r.id, 'refetch') : keys.get(from)!
    objects.set(key, body)
    await db
      .update(resource)
      .set({
        storageKey: key,
        hash: opts.rowSays ? opts.rowSays.hash : hashBuffer(body),
        size: opts.rowSays ? opts.rowSays.size : body.length,
      })
      .where(eq(resource.id, r.id))
  }

  const [pipeline] = await db
    .insert(resourcePipeline)
    .values({
      resourceId: r.id,
      status: 'complete',
      metadata:
        opts.sourceHash === null
          ? { schema: opts.schema }
          : { sourceHash: opts.sourceHash ?? (await liveHash(r.id)), schema: opts.schema },
    })
    .returning()
  await db
    .insert(resourcePipelineStep)
    .values({ pipelineId: pipeline.id, stepName: 'extract', status: 'complete' })
  return r.id
}

async function liveHash(resourceId: string): Promise<string> {
  const [row] = await db
    .select({ hash: resource.hash })
    .from(resource)
    .where(eq(resource.id, resourceId))
  return row?.hash ?? ''
}

async function versionsOf(resourceId: string) {
  return db
    .select({
      version: resourceVersion.version,
      state: resourceVersion.state,
      storageKey: resourceVersion.storageKey,
      origin: resourceVersion.origin,
      hash: resourceVersion.hash,
      restoredFrom: resourceVersion.restoredFrom,
      schema: resourceVersion.schema,
    })
    .from(resourceVersion)
    .where(eq(resourceVersion.resourceId, resourceId))
    .orderBy(resourceVersion.version)
}

async function liveKey(resourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ storageKey: resource.storageKey })
    .from(resource)
    .where(eq(resource.id, resourceId))
  return row?.storageKey ?? null
}

beforeEach(async () => {
  objects.clear()
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-convert', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('convertSetAsideVersions', () => {
  it('issues the content of a lower owner as the newest version, then flips', async () => {
    // What an old-style revert to v1 left: v2 and v3 set aside, live on v1.
    const id = await addResource({
      name: 'reverted',
      versions: [
        { version: 1 },
        { version: 2, state: 'superseded' },
        { version: 3, state: 'superseded' },
      ],
      live: 1,
    })

    expect(
      await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    ).toMatchObject({
      converted: 1,
      skipped: 0,
      failed: 0,
    })

    const rows = await versionsOf(id)
    expect(rows.map((r) => r.state)).toEqual(['active', 'active', 'active', 'active'])
    // v4 holds v1's content, under an object of its own — a version owns what
    // it names, so the copy is what makes both purgeable.
    const issued = rows[3]
    expect(issued.version).toBe(4)
    expect(issued.origin).toBe('revert')
    expect(issued.restoredFrom).toBe(1)
    expect(issued.storageKey).not.toBe(rows[0].storageKey)
    expect(objects.get(issued.storageKey)).toEqual(objects.get(rows[0].storageKey))
    // And it is what the resource serves, so the newest version is the live one.
    expect(await liveKey(id)).toBe(issued.storageKey)
  })

  it('takes over a live object no version owns, without copying it', async () => {
    // An unchanged re-fetch published a fresh key and the gate created no
    // version for it — the shape that arises on its own, forever.
    const id = await addResource({
      name: 'unowned',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
    })
    const before = await liveKey(id)

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows.map((r) => r.state)).toEqual(['active', 'active', 'active'])
    const issued = rows[2]
    expect(issued.version).toBe(3)
    // The object itself, not a copy: nobody owned it (ADR-043 §1-2).
    expect(issued.storageKey).toBe(before)
    expect(await liveKey(id)).toBe(before)
    // No comparison settles which version those bytes came from, so it says so
    // — and the origin is how the bytes got here, not a revert this migration
    // would be inventing.
    expect(issued.restoredFrom).toBeNull()
    expect(issued.origin).toBe('upload')
  })

  it('only flips when the topmost version already owns live', async () => {
    // A revert to v2 followed by a new upload: v3 was set aside, v4 is live.
    const id = await addResource({
      name: 'already-on-top',
      versions: [
        { version: 1 },
        { version: 2 },
        { version: 3, state: 'superseded' },
        { version: 4 },
      ],
      live: 4,
    })
    const before = await liveKey(id)

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.state)).toEqual(['active', 'active', 'active', 'active'])
    expect(await liveKey(id)).toBe(before)
  })

  it('only flips when the resource is serving nothing', async () => {
    const id = await addResource({
      name: 'emptied',
      versions: [
        { version: 1, state: 'superseded' },
        { version: 2, state: 'superseded' },
      ],
      live: 'none',
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.state)).toEqual(['active', 'active'])
    expect(await liveKey(id)).toBeNull()
  })

  it('converts a deleted resource too', async () => {
    // Its rows are rows: left out, they would keep `superseded` alive forever.
    const id = await addResource({
      name: 'deleted',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
      state: 'deleted',
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    expect((await versionsOf(id)).map((r) => r.state)).toEqual(['active', 'active', 'active'])
    expect(await service.countUnconvertedReverts()).toBe(0)
  })

  it('is idempotent: a second pass finds nothing to convert', async () => {
    const id = await addResource({
      name: 'twice',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    const afterFirst = await versionsOf(id)

    expect(await service.countUnconvertedReverts()).toBe(0)
    expect(
      await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    ).toMatchObject({
      converted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(await versionsOf(id)).toEqual(afterFirst)
  })

  it('leaves a claimed resource for the next pass', async () => {
    const id = await addResource({
      name: 'held',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    const held = await claimResources(db, [id], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
    expect(held.claimed).toHaveLength(1)

    expect(
      await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    ).toMatchObject({
      converted: 0,
      skipped: 1,
      failed: 0,
    })
    // Nothing half-done: the rows are as they were.
    expect((await versionsOf(id)).map((r) => r.state)).toEqual(['active', 'superseded'])
  })

  it('writes no schema onto a taken-over object when the recorded one is unproven', async () => {
    // A failed interpretation leaves the previous schema on the row. Copied
    // unchecked, a zero-column one would drop the version out of the layer-2
    // sweep for good.
    const id = await addResource({
      name: 'stale-schema',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
      sourceHash: 'sha256:something-else',
      schema: { columns: [] },
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows[2].schema).toBeNull()
  })

  it('carries the interpretation over when it describes the live content', async () => {
    const id = await addResource({
      name: 'good-schema',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
      schema: { columns: [{ name: 'a', type: 'VARCHAR' }] },
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows[2].schema).toEqual({ columns: [{ name: 'a', type: 'VARCHAR' }] })
  })

  it('takes over a live object whose bytes match a version below the topmost', async () => {
    // The arrangement the hash guess gets wrong, and the reason ownership is
    // asked of the object: v1 and the live object hold the same bytes, so a
    // guess would call v1 the owner and issue a copy of it — when what is
    // serving is an object nobody owns and the migration should simply take it.
    const id = await addResource({
      name: 'unowned-matching-lower',
      versions: [
        { version: 1, content: 'shared' },
        { version: 2, state: 'superseded', content: 'other' },
      ],
      live: { unowned: 1 },
    })
    const before = await liveKey(id)
    const storage = mockStorage()

    await service.convertSetAsideVersions({ storage, queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows).toHaveLength(3)
    expect(rows[2].storageKey).toBe(before)
    expect(await liveKey(id)).toBe(before)
    expect(storage.copy).not.toHaveBeenCalled()
  })

  it('ignores tombstones when deciding who is topmost and who owns live', async () => {
    // A purged version keeps its number and its key, and owns neither. Counted
    // as the topmost row, the migration would think the resource was already in
    // shape; counted as the owner, it would issue a copy of content that is
    // gone.
    const id = await addResource({
      name: 'with-tombstones',
      versions: [
        { version: 1 },
        { version: 2, state: 'superseded' },
        { version: 3, state: 'purged' },
      ],
      live: 1,
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows.map((r) => r.state)).toEqual(['active', 'active', 'purged', 'active'])
    expect(rows[3].version).toBe(4)
    expect(rows[3].restoredFrom).toBe(1)
    expect(await liveKey(id)).toBe(rows[3].storageKey)
  })

  it('flips only the resource it claimed', async () => {
    const converted = await addResource({
      name: 'convert-me',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    const held = await addResource({
      name: 'leave-me',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    await claimResources(db, [held], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')

    expect(
      await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    ).toMatchObject({
      converted: 1,
      skipped: 1,
      failed: 0,
    })

    expect((await versionsOf(converted)).map((r) => r.state)).toEqual([
      'active',
      'active',
      'active',
    ])
    expect((await versionsOf(held)).map((r) => r.state)).toEqual(['active', 'superseded'])
  })

  it('issues before it flips, so the two are never the wrong way round', async () => {
    // Read from inside the copy, which is the one moment between the decision
    // and the issue. Flipping first would show the rows already active while
    // the version holding the live content is still the lower one — the state
    // this migration exists to remove, produced by the migration itself.
    const id = await addResource({
      name: 'ordering',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    let statesDuringCopy: string[] = []
    const storage = mockStorage({
      copy: async (src: string, dest: string) => {
        statesDuringCopy = (await versionsOf(id)).map((r) => r.state)
        objects.set(dest, objects.get(src)!)
      },
    })

    await service.convertSetAsideVersions({ storage, queue: mockQueue() })

    expect(statesDuringCopy).toEqual(['active', 'superseded'])
  })

  it('leaves everything alone when the claim is taken mid-conversion', async () => {
    const id = await addResource({
      name: 'stolen',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    const before = await liveKey(id)
    const storage = mockStorage({
      copy: async (src: string, dest: string) => {
        // Stale after 0ms, so the resource is claimable out from under the
        // migration exactly as a 15-minute stall would leave it.
        await claimResources(db, [id], randomUUID(), 0, 'run')
        objects.set(dest, objects.get(src)!)
      },
    })

    expect(await service.convertSetAsideVersions({ storage, queue: mockQueue() })).toMatchObject({
      converted: 0,
      skipped: 1,
      failed: 0,
    })
    expect((await versionsOf(id)).map((r) => r.state)).toEqual(['active', 'superseded'])
    expect(await liveKey(id)).toBe(before)
  })

  it('refuses to take over an object the resource stopped serving', async () => {
    // The pointer moves during the measurement, which is the window an upload
    // has: it takes no claim (ADR-044 §4). The version must not name an object
    // that is no longer the content.
    const id = await addResource({
      name: 'pointer-moved',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
    })
    const storage = mockStorage({
      download: async (key: string) => {
        await db
          .update(resource)
          .set({ storageKey: getStorageKey(packageId, id, 'uploaded') })
          .where(eq(resource.id, id))
        return Readable.from(objects.get(key)!)
      },
    })

    expect(await service.convertSetAsideVersions({ storage, queue: mockQueue() })).toMatchObject({
      converted: 0,
      skipped: 1,
      failed: 0,
    })
    expect(await versionsOf(id)).toHaveLength(2)
  })

  it('measures the live object rather than believing the row', async () => {
    // Pre-existing data: `upload-complete` used to accept any string as a hash,
    // and the size can be whatever the client claimed. Both are what the live
    // guess and the version gate compare against later.
    const id = await addResource({
      name: 'lying-row',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
      rowSays: { hash: 'not-a-real-hash', size: 999999 },
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    const truth = hashBuffer(objects.get((await liveKey(id))!)!)
    expect(rows[2].hash).toBe(truth)
    // And the row is corrected under the same lock, or the two would disagree
    // about the same bytes for good.
    const [row] = await db
      .select({ hash: resource.hash, size: resource.size })
      .from(resource)
      .where(eq(resource.id, id))
    expect(row.hash).toBe(truth)
    expect(row.size).toBe(objects.get((await liveKey(id))!)!.length)
  })

  it('leaves the label and the interpretation alone when issuing a copy', async () => {
    // The served bytes do not change — the version being copied already owns
    // them — so nothing the resource says about itself may change either. A
    // revert would move both to the destination's, and for this vintage the
    // destination's schema is null, which would wipe a live interpretation with
    // no rebuild queued to replace it.
    const id = await addResource({
      name: 'keeps-its-label',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
      schema: { columns: [{ name: 'a', type: 'VARCHAR' }] },
    })
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, id))

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const [row] = await db
      .select({ format: resource.format })
      .from(resource)
      .where(eq(resource.id, id))
    expect(row.format).toBe('TSV')
    const [pipeline] = await db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, id))
    expect(pipeline.metadata).toMatchObject({ schema: { columns: [{ name: 'a' }] } })
  })

  it('trusts a schema from before sourceHash existed when the extract completed', async () => {
    // The fallback the trust predicate carries for old rows: no `sourceHash` at
    // all, but a completed pipeline whose extract step finished.
    const id = await addResource({
      name: 'pre-source-hash',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: { unowned: 2 },
      sourceHash: null,
      schema: { columns: [{ name: 'a', type: 'VARCHAR' }] },
    })

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    expect((await versionsOf(id))[2].schema).toEqual({ columns: [{ name: 'a', type: 'VARCHAR' }] })
  })

  it('carries the interpretation only while the label still agrees', async () => {
    // The version takes its format off the resource as it stands, so a resource
    // relabelled since the old revert would otherwise record today's format
    // against yesterday's columns — and relabelled to something non-tabular it
    // leaves the layer-2 sweep too, where nothing would correct it.
    const id = await addResource({
      name: 'relabelled',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
      schema: { columns: [{ name: 'a', type: 'VARCHAR' }] },
    })
    await db
      .update(resourceVersion)
      .set({
        schema: {
          columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
          rowCount: 1,
        },
      })
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, id))

    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })

    const rows = await versionsOf(id)
    expect(rows[2].version).toBe(3)
    expect(rows[2].schema).toBeNull()
  })

  it('hands layer 2 one version per resource, the oldest', async () => {
    // The conversion makes several versions of one resource eligible at once.
    // Queued together they race, and whichever the worker ingests first
    // overtakes the rest for good — so only the oldest goes out.
    const id = await addResource({
      name: 'several-pending',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    const queue = mockQueue()

    await service.convertSetAsideVersions({ storage: mockStorage(), queue })

    const forThis = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[1] as { resourceId: string }).resourceId === id
    )
    expect(forThis).toHaveLength(1)
    expect((forThis[0][1] as { version: number }).version).toBe(1)
  })

  it('hands on to the next version the resource owes layer 2', async () => {
    // What keeps the backlog the conversion frees from draining an hour at a
    // time — long enough for ordinary content to arrive above it and overtake
    // the rest for good.
    const id = await addResource({
      name: 'chained',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    // v1 goes out first; pretend the worker loaded it.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 1 })
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 1)))

    const queue = mockQueue()
    expect(await service.queueNextPendingLakeIngest(queue, id, 1)).toBe(true)
    expect((queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      resourceId: id,
      version: 2,
    })
  })

  it('stops handing on once the resource owes layer 2 nothing', async () => {
    const id = await addResource({
      name: 'drained',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    // The newest carries a snapshot, so everything below it is overtaken.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 9 })
      .where(and(eq(resourceVersion.resourceId, id), eq(resourceVersion.version, 3)))

    const queue = mockQueue()
    expect(await service.queueNextPendingLakeIngest(queue, id, 3)).toBe(false)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('does not hand a version back to itself', async () => {
    // An attempt that interpreted nothing records neither a snapshot nor an
    // empty schema, so its version is still outstanding. Chained to itself it
    // would come straight back, forever.
    const id = await addResource({
      name: 'self-chain',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })
    await service.convertSetAsideVersions({ storage: mockStorage(), queue: mockQueue() })
    // Everything below is loaded, so the newest — the one just handled — is the
    // only version outstanding. Only the exclusion keeps it from coming back.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 5 })
      .where(and(eq(resourceVersion.resourceId, id), inArray(resourceVersion.version, [1, 2])))

    const queue = mockQueue()
    expect(await service.queueNextPendingLakeIngest(queue, id, 3)).toBe(false)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('counts resources, not rows', async () => {
    await addResource({
      name: 'many-rows',
      versions: [
        { version: 1 },
        { version: 2, state: 'superseded' },
        { version: 3, state: 'superseded' },
      ],
      live: 1,
    })
    await addResource({
      name: 'one-row',
      versions: [{ version: 1 }, { version: 2, state: 'superseded' }],
      live: 1,
    })

    expect(await service.countUnconvertedReverts()).toBe(2)
  })
})
