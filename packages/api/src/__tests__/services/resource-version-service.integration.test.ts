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
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import {
  ResourceVersionService,
  insertVersionIfHeld,
} from '../../services/resource-version-service'
import {
  CLAIM_STALE_AFTER_MS,
  cancelResourceRun,
  claimResources,
} from '../../services/pipeline-claim'
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
  // Cast through unknown rather than to `never`: these carry only the methods
  // the purge and the revert reach for, and `never` has no properties at all,
  // so every `vi.mocked(deps.storage.delete)` below would be reading one off it.
  return {
    storage: { copy: vi.fn(), delete: vi.fn() } as unknown as StorageAdapter,
    search: { deleteContent: vi.fn() } as unknown as SearchAdapter,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as unknown as QueueAdapter,
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
    await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')

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
    // (ADR-043 §5). An unusable config proves it: the purge fails rather than
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

describe('insertVersionIfHeld', () => {
  const captured = {
    version: 1,
    storageKey: 'versions/pkg/res/v1',
    size: 10,
    hash: 'sha256:v1',
    origin: 'upload' as const,
    schema: null,
  }

  async function versions() {
    return db.select().from(resourceVersion).where(eq(resourceVersion.resourceId, resourceId))
  }

  it('records the version while the run holds the resource', async () => {
    await db.insert(resourcePipeline).values({ resourceId })
    const { claimed } = await claimResources(
      db,
      [resourceId],
      randomUUID(),
      CLAIM_STALE_AFTER_MS,
      'run'
    )

    expect(await insertVersionIfHeld(db, claimed[0], { resourceId, ...captured })).toBe(true)
    expect(await versions()).toHaveLength(1)
  })

  it('records nothing once the run has been stopped', async () => {
    // The step that would have reported this version is the one the kill cut
    // off, so a row written anyway has the resource page calling saved content
    // unsaved (ADR-044 §4).
    await db.insert(resourcePipeline).values({ resourceId })
    const { claimed } = await claimResources(
      db,
      [resourceId],
      randomUUID(),
      CLAIM_STALE_AFTER_MS,
      'run'
    )
    await cancelResourceRun(db, resourceId)

    expect(await insertVersionIfHeld(db, claimed[0], { resourceId, ...captured })).toBe(false)
    expect(await versions()).toEqual([])
  })

  it('records a version for a resource that has no pipeline row', async () => {
    // Not a missing claim: a run cannot start without that row either, so
    // there is nothing for the backfill to lose a race against.
    expect(await insertVersionIfHeld(db, null, { resourceId, ...captured })).toBe(true)
    expect(await versions()).toHaveLength(1)
  })
})

describe('revertLiveContent — the middle rung (ADR-044 §4)', () => {
  it('stops the run and puts the live content back', async () => {
    // The wrong file was uploaded and is live. Stopping alone would leave it
    // downloadable and its content in the search index.
    await db.insert(resourcePipeline).values({ resourceId })
    await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
    await addVersion(1, 'sha256:v1')

    const deps = mockDeps()
    const result = await service.revertLiveContent(resourceId, deps)

    expect(result).toEqual({ cancelled: true, restored: 1 })
    // v1's bytes are copied to a key of this operation's own, never reused.
    const [, restoredKey] = vi.mocked(deps.storage.copy).mock.calls[0]
    expect(restoredKey).not.toBe(liveKey)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(restoredKey)
    expect(res.hash).toBe('sha256:v1')
    // Derivatives describing the retracted content go now, and are rebuilt.
    expect(deps.search.deleteContent).toHaveBeenCalledWith(resourceId)
    expect(deps.queue.enqueue).toHaveBeenCalled()
  })

  it('parks the retracted object rather than deleting it', async () => {
    // Unwanted, not illegal — a reader that already resolved the key deserves
    // to finish. Destroying it is the rung above.
    await addVersion(1, 'sha256:v1')

    const deps = mockDeps()
    await service.revertLiveContent(resourceId, deps)

    expect(deps.storage.delete).not.toHaveBeenCalledWith(liveKey)
    const parked = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect((parked.rows as unknown as { key: string }[]).map((r) => r.key)).toContain(liveKey)
  })

  it('empties the resource when no version survives to restore', async () => {
    // A first upload that was wrong: there is nothing to go back to, and
    // leaving it live would be the one thing the caller asked against.
    const deps = mockDeps()
    const result = await service.revertLiveContent(resourceId, deps)

    expect(result.restored).toBeNull()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBeNull()
    expect(res.hash).toBeNull()
    // Nothing to rebuild from.
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('reports when there was no run to stop', async () => {
    await addVersion(1, 'sha256:v1')

    expect((await service.revertLiveContent(resourceId, mockDeps())).cancelled).toBe(false)
  })

  it('leaves a version captured from the retracted content alone', async () => {
    // The ladder: destroying that version is a purge, which this deliberately
    // is not. Reverting the pointer must not quietly delete version rows.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')

    await service.revertLiveContent(resourceId, mockDeps())

    expect((await service.listByResource(resourceId)).map((v) => v.version)).toEqual([2, 1])
  })

  it('holds the resource for the whole revert', async () => {
    // Cancelling and then claiming leaves the resource free in between, long
    // enough for a waiting job to start writing over what is being retracted.
    const [pipe] = await db.insert(resourcePipeline).values({ resourceId }).returning()
    await addVersion(1, 'sha256:v1')

    let heldDuringCopy = false
    const deps = mockDeps()
    vi.mocked(deps.storage.copy).mockImplementation(async () => {
      const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
      heldDuringCopy = row.claimOwner !== null
    })

    await service.revertLiveContent(resourceId, deps)

    expect(heldDuringCopy).toBe(true)
    const [after] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
    expect(after.claimOwner).toBeNull()
  })

  it('refuses while a purge holds the resource', async () => {
    await db.insert(resourcePipeline).values({ resourceId })
    await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS, 'job')
    await addVersion(1, 'sha256:v1')

    await expect(service.revertLiveContent(resourceId, mockDeps())).rejects.toThrow(
      /being processed/
    )
  })

  it('does not report a restore it lost, nor delete the winner derivatives', async () => {
    // Uploads do not take the claim (ADR-044 §6), so the live pointer can move
    // while this runs. Calling that a restore would delete the preview and the
    // indexed content of whatever won.
    await addVersion(1, 'sha256:v1')

    const deps = mockDeps()
    vi.mocked(deps.storage.copy).mockImplementation(async () => {
      await db
        .update(resource)
        .set({ storageKey: 'resources/pkg/newer', hash: 'sha256:newer' })
        .where(eq(resource.id, resourceId))
    })

    await expect(service.revertLiveContent(resourceId, deps)).rejects.toThrow(/changed/)

    expect(deps.search.deleteContent).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe('resources/pkg/newer')
  })
})
