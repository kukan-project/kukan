/**
 * Integration tests for ResourceVersionService purge flow (ADR-043, layer 1).
 * Exercises claim (active → purging) and worker execution (file deletion,
 * rollback of the live version, tombstone) against real PostgreSQL.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import { getStorageKey, getVersionKey } from '@kukan/shared'
import { ResourceVersionService } from '../../services/resource-version-service'
import { CLAIM_STALE_AFTER_MS, claimResources } from '../../services/pipeline-claim'
import { unreachableLake } from '../test-helpers/fixtures'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string
let resourceId: string
let liveKey: string
const userId = TEST_USER_ID

function mockDeps() {
  return {
    storage: { copy: vi.fn(), delete: vi.fn() } as never,
    search: { deleteContent: vi.fn() } as never,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
  }
}

async function addVersion(version: number, hash: string, state = 'active') {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getVersionKey(packageId, resourceId, version),
    size: 100 + version,
    hash,
    origin: 'upload',
    state,
  })
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-versions', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const res = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload', hash: 'sha256:v2', size: 102 })
    .returning()
  resourceId = res[0].id
  liveKey = getStorageKey(packageId, resourceId, 'live')
  await db.update(resource).set({ storageKey: liveKey }).where(eq(resource.id, resourceId))
})

afterAll(async () => {
  await closeTestDb()
})

describe('claimPurge', () => {
  it('transitions active → purging and records who/why', async () => {
    await addVersion(1, 'sha256:v1')
    const { claimed, view } = await service.claimPurge(resourceId, 1, userId, 'contains PII')

    expect(claimed).toBe(true)
    expect(view.state).toBe('purging')
    const [row] = await db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.state).toBe('purging')
    expect(row.purgedBy).toBe(userId)
    expect(row.purgeReason).toBe('contains PII')
  })

  it('is idempotent — a non-active version is not re-claimed', async () => {
    await addVersion(1, 'sha256:v1', 'purging')
    const { claimed } = await service.claimPurge(resourceId, 1, userId, 'again')
    expect(claimed).toBe(false)
  })
})

describe('executePurge', () => {
  it('rolls the live version back to the previous one', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2') // live (matches resource.hash)
    await service.claimPurge(resourceId, 2, userId, 'illegal content')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 2, deps)

    expect(result).toEqual({ purged: true, rolledBack: true })
    // v2's versioned copy deleted.
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 2))
    // v1 restored to a fresh key, and the pointer moved to it.
    const [restoredTo] = vi.mocked(deps.storage.copy).mock.calls[0].slice(1)
    expect(deps.storage.copy).toHaveBeenCalledWith(
      getVersionKey(packageId, resourceId, 1),
      expect.stringMatching(/^resources\/.+\/.+\..+$/)
    )
    expect(restoredTo).not.toBe(liveKey)
    // The object that held the purged content is deleted, not parked: a purge
    // is a legal deletion, so an in-flight reader is meant to be cut off.
    expect(deps.storage.delete).toHaveBeenCalledWith(liveKey)
    // Pipeline re-enqueued to regenerate derivatives.
    expect(deps.queue.enqueue).toHaveBeenCalled()

    // resource hash rolled back to v1, pointing at the restored object.
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')
    expect(res.storageKey).toBe(restoredTo)

    // v2 is a purged tombstone; content fields withheld via the view.
    const view = await service.getVersion(resourceId, 2)
    expect(view.state).toBe('purged')
    expect(view.hash).toBeNull()
  })

  it('empties the resource when no previous active version remains', async () => {
    await addVersion(1, 'sha256:v2') // only version, live
    await db.update(resource).set({ hash: 'sha256:v2' }).where(eq(resource.id, resourceId))
    await service.claimPurge(resourceId, 1, userId, 'illegal')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)

    expect(result).toEqual({ purged: true, rolledBack: false })
    // Live object deleted (nothing to roll back to), pointer cleared.
    expect(deps.storage.delete).toHaveBeenCalledWith(liveKey)
    expect(deps.queue.enqueue).not.toHaveBeenCalled()

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBeNull()
    expect(res.storageKey).toBeNull()
  })

  it('purging a historical (non-live) version leaves the current key intact', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2') // live
    await service.claimPurge(resourceId, 1, userId, 'old mistake')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)

    expect(result).toEqual({ purged: true, rolledBack: false })
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 1))
    // No rollback / current-key touch for a non-live version.
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v2')
  })

  it('is idempotent — a version not in purging state is a no-op', async () => {
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)
    expect(result).toEqual({ purged: false, rolledBack: false })
    expect(deps.storage.delete).not.toHaveBeenCalled()
  })
})

describe('executePurge — the resource claim (ADR-044)', () => {
  it('defers while a run holds the resource, leaving the version purging', async () => {
    // The run may be between writing a preview and recording it. Sweeping now
    // would leave that object behind with nothing left to reclaim it.
    await db.insert(resourcePipeline).values({ resourceId })
    await addVersion(1, 'sha256:v2')
    await service.claimPurge(resourceId, 1, userId, 'illegal')
    await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS)

    const deps = mockDeps()
    await expect(service.executePurge(resourceId, 1, deps)).rejects.toThrow(/being processed/)

    expect(deps.storage.delete).not.toHaveBeenCalled()
    // Still claimed for purge, so the redelivered job finishes it.
    expect((await service.getVersion(resourceId, 1)).state).toBe('purging')
  })

  it('holds the resource while it purges', async () => {
    const [pipe] = await db.insert(resourcePipeline).values({ resourceId }).returning()
    await addVersion(1, 'sha256:v2')
    await service.claimPurge(resourceId, 1, userId, 'illegal')

    let heldDuringDelete = false
    const deps = mockDeps()
    vi.mocked(deps.storage.delete).mockImplementation(async () => {
      const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
      heldDuringDelete = row.claimOwner !== null
    })

    await service.executePurge(resourceId, 1, deps)

    expect(heldDuringDelete).toBe(true)
    // And given back, so the pipeline this re-enqueues can start.
    const [after] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
    expect(after.claimOwner).toBeNull()
  })
})

describe('executePurge — layer 2 (DuckLake)', () => {
  it('clears the snapshot reference on the tombstone', async () => {
    await addVersion(1, 'sha256:v1')
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 42 })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    await service.claimPurge(resourceId, 1, userId, 'test')

    // No lake config: layer 2 is skipped, but the reference must still be dropped.
    await service.executePurge(resourceId, 1, mockDeps())

    const [row] = await db
      .select({ snap: resourceVersion.ducklakeSnapshotId, state: resourceVersion.state })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.state).toBe('purged')
    expect(row.snap).toBeNull()
  })

  it('reaches the lake when purging a middle version that reached it', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 7 })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    await service.claimPurge(resourceId, 1, userId, 'test')

    // v2 stays live, so the contents do not change — but v1's snapshot still
    // holds its rows and has to be reclaimed, so the lake is contacted anyway
    // (ADR-043 §9). An unusable config proves it: the purge fails rather than
    // reporting a legal deletion it did not carry out.
    await expect(
      service.executePurge(resourceId, 1, { ...mockDeps(), lake: unreachableLake })
    ).rejects.toThrow()

    const [row] = await db
      .select({ state: resourceVersion.state })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.state).toBe('purging')
  }, 60_000)

  it('leaves the lake alone for a version that never reached it', async () => {
    // Most resources are not tabular. Opening a session costs extension loads
    // and a catalog ATTACH, so a version with no snapshot must not pay it —
    // an unusable config proves the lake is never contacted.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await service.claimPurge(resourceId, 1, userId, 'test')

    const result = await service.executePurge(resourceId, 1, {
      ...mockDeps(),
      lake: unreachableLake,
    })

    expect(result.purged).toBe(true)
  })
})
