/**
 * Integration tests for ResourceVersionService purge flow (ADR-043, layer 1).
 * Exercises claim (active → purging) and worker execution (file deletion,
 * rollback of the live version, tombstone) against real PostgreSQL.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import { createLogger, getStorageKey, getVersionKey, MAX_PARQUET_SOURCE_SIZE } from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import {
  ResourceVersionService,
  insertVersionIfHeld,
  setVersionSchemaIfHeld,
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
const silentLogger = createLogger({ name: 'test', level: 'silent' })
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
    storage: {
      copy: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockImplementation((keys: string[]) => Promise.resolve(keys)),
    } as unknown as StorageAdapter,
    search: { deleteContent: vi.fn() } as unknown as SearchAdapter,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as unknown as QueueAdapter,
  }
}

async function addVersion(
  version: number,
  hash: string,
  state = 'active',
  format?: string,
  schema?: ResourceSchema
) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getVersionKey(packageId, resourceId, version, 'v'),
    size: 100 + version,
    hash,
    origin: 'upload',
    state,
    format,
    schema,
  })
}

/** Columns, named so a test can tell which version's interpretation it is. */
function columns(...names: string[]): ResourceSchema {
  return {
    rowCount: 1,
    columns: names.map((name) => ({
      name,
      type: 'string' as const,
      nullable: false,
      nullCount: 0,
    })),
  }
}

/** The cached interpretation the resource is carrying right now. */
/** Only what the row says about the interpretation — the same row carries the
 *  content-index record, which the cases here are not about. */
async function cachedInterpretation() {
  const [row] = await db
    .select({ metadata: resourcePipeline.metadata })
    .from(resourcePipeline)
    .where(eq(resourcePipeline.resourceId, resourceId))
  const { schema, sourceHash } = (row?.metadata ?? {}) as {
    schema?: ResourceSchema
    sourceHash?: string
  }
  return {
    ...(schema !== undefined && { schema }),
    ...(sourceHash !== undefined && { sourceHash }),
  }
}

/**
 * Revert from wherever the content is standing. Most cases are about what a
 * revert does, not about naming the version — that is its own case below.
 */
async function revertFromLive(deps = mockDeps()) {
  const { revertTarget, liveRevision } = await service.revertContext(resourceId)
  return service.revertLiveContent(
    resourceId,
    { restoreTo: revertTarget, ifLiveRevision: liveRevision },
    deps
  )
}

/** A run holding the resource, so a test can check whether it was stopped. */
async function startRun(): Promise<string> {
  const owner = randomUUID()
  await db
    .insert(resourcePipeline)
    .values({ resourceId, status: 'processing', claimOwner: owner, claimKind: 'run' })
    .onConflictDoUpdate({
      target: resourcePipeline.resourceId,
      set: { status: 'processing', claimOwner: owner, claimKind: 'run', claimOwnerAt: sql`NOW()` },
    })
  return owner
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

  it('is idempotent — a version already being purged is not re-claimed', async () => {
    await addVersion(1, 'sha256:v1', 'purging')
    const { claimed } = await service.claimPurge(resourceId, 1, userId, 'again')
    expect(claimed).toBe(false)
  })

  it('claims a superseded version — a revert is not a destruction', async () => {
    await addVersion(1, 'sha256:v1', 'superseded')
    const { claimed, view } = await service.claimPurge(resourceId, 1, userId, 'illegal')
    expect(claimed).toBe(true)
    expect(view.state).toBe('purging')
  })
})

describe('executePurge', () => {
  it('keeps the object live is standing on when a same-hash version is purged', async () => {
    // Live and a version share an object now (ADR-043 §1), and the copying path
    // deliberately produces versions with one hash. Asked by hash, "is live
    // standing on this version" answers with the newest of them — so purging a
    // superseded one restored live onto v1's file and then deleted it.
    const v1Key = getVersionKey(packageId, resourceId, 1, 'v')
    await addVersion(1, 'sha256:same')
    await addVersion(2, 'sha256:same', 'superseded', 'TSV')
    // The state a revert leaves: live back on v1's own object.
    await db
      .update(resource)
      .set({ storageKey: v1Key, hash: 'sha256:same' })
      .where(eq(resource.id, resourceId))
    await service.claimPurge(resourceId, 2, userId, 'illegal content')

    const deps = mockDeps()
    await service.executePurge(resourceId, 2, deps)

    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 2, 'v'))
    expect(deps.storage.delete).not.toHaveBeenCalledWith(v1Key)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(v1Key)
  })

  it('rolls back when live is standing on the version being purged, whatever shares its hash', async () => {
    // The same misreading in the other direction: a newer version with the same
    // hash made this look like a middle version, so the purge deleted the live
    // object and skipped the rollback — leaving the retracted content in the
    // index and the preview.
    const v1Key = getVersionKey(packageId, resourceId, 1, 'v')
    const v2Key = getVersionKey(packageId, resourceId, 2, 'v')
    await addVersion(1, 'sha256:same')
    await addVersion(2, 'sha256:same', 'active', 'TSV')
    await db
      .update(resource)
      .set({ storageKey: v1Key, hash: 'sha256:same' })
      .where(eq(resource.id, resourceId))
    await service.claimPurge(resourceId, 1, userId, 'illegal content')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)

    expect(result).toEqual({ purged: true, rolledBack: true })
    // The derivatives of the retracted content go, which the middle-version
    // branch would have skipped.
    expect(deps.search.deleteContent).toHaveBeenCalledWith(resourceId)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(v2Key)
    expect(deps.storage.delete).toHaveBeenCalledWith(v1Key)
  })

  it('rolls the live version back to the previous one', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2') // live (matches resource.hash)
    await service.claimPurge(resourceId, 2, userId, 'illegal content')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 2, deps)

    expect(result).toEqual({ purged: true, rolledBack: true })
    // v2's versioned copy deleted.
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 2, 'v'))
    // The pointer moves onto v1's own object — no copy is made to carry it
    // under the `resources/` prefix (ADR-043 §1).
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [row] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(row.storageKey).toBe(getVersionKey(packageId, resourceId, 1, 'v'))
    // The object that held the purged content is deleted, not parked: a purge
    // is a legal deletion, so an in-flight reader is meant to be cut off.
    expect(deps.storage.delete).toHaveBeenCalledWith(liveKey)
    // Pipeline re-enqueued to regenerate derivatives.
    expect(deps.queue.enqueue).toHaveBeenCalled()

    // resource hash rolled back to v1, pointing at the restored object.
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')

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
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 1, 'v'))
    // No rollback / current-key touch for a non-live version.
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v2')
  })

  it('leaves the pointer alone when another version holds the same bytes', async () => {
    // Several versions may hold one hash (ADR-046 §3), so "the live object has
    // these bytes" does not identify the version the pointer stands on. v2 is
    // where it stands; purging v1 must not move it.
    await addVersion(1, 'sha256:v2')
    await addVersion(2, 'sha256:v2') // live
    await service.claimPurge(resourceId, 1, userId, 'old mistake')

    const deps = mockDeps()
    expect(await service.executePurge(resourceId, 1, deps)).toEqual({
      purged: true,
      rolledBack: false,
    })
    expect(deps.storage.copy).not.toHaveBeenCalled()
    expect(deps.storage.delete).not.toHaveBeenCalledWith(liveKey)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(liveKey)
  })

  it('is idempotent — a version not in purging state is a no-op', async () => {
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)
    expect(result).toEqual({ purged: false, rolledBack: false })
    expect(deps.storage.delete).not.toHaveBeenCalled()
  })
})

describe('executePurge — after a revert (ADR-044 §4)', () => {
  it('destroys a version the revert stepped off, without touching the live content', async () => {
    // A revert destroys nothing, so content that should never have been served
    // survives it. Purging that version on its own is the rung above — and
    // refusing it would strand the one version most likely to need destroying.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await revertFromLive()

    const { claimed } = await service.claimPurge(resourceId, 2, userId, 'should never have run')
    expect(claimed).toBe(true)

    const deps = mockDeps()
    expect(await service.executePurge(resourceId, 2, deps)).toEqual({
      purged: true,
      rolledBack: false,
    })
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 2, 'v'))
    // v1's content is live; the version being destroyed is not, so nothing moves.
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')
  })

  it('rolls back when the live version has a stepped-off one above it', async () => {
    // Liveness read from version order — "nothing active sits above this" —
    // answers no here, because the revert left v3 numbered above the content it
    // restored. The purge then deleted v2's version file and left the live
    // object still serving those very bytes: a legal deletion that does not
    // delete.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await addVersion(3, 'sha256:v3')
    await db.update(resource).set({ hash: 'sha256:v3' }).where(eq(resource.id, resourceId))
    await revertFromLive()

    await service.claimPurge(resourceId, 2, userId, 'illegal content')
    const deps = mockDeps()
    expect(await service.executePurge(resourceId, 2, deps)).toEqual({
      purged: true,
      rolledBack: true,
    })

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')
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
  const created = {
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

    expect(await insertVersionIfHeld(db, claimed[0], { resourceId, ...created })).toBe(true)
    expect(await versions()).toHaveLength(1)
  })

  it('records the format the resource carries at insert time (ADR-046)', async () => {
    // The condition this version's interpretation is made under, settled with
    // its bytes. A later relabel describes what the next create will be read
    // as, and leaves the rows already here alone.
    await db.update(resource).set({ format: 'CSV' }).where(eq(resource.id, resourceId))
    expect(await insertVersionIfHeld(db, null, { resourceId, ...created })).toBe(true)

    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))
    expect(
      await insertVersionIfHeld(db, null, {
        resourceId,
        ...created,
        version: 2,
        storageKey: 'versions/pkg/res/v2',
        hash: 'sha256:v2',
      })
    ).toBe(true)

    const rows = (await versions()).sort((a, b) => a.version - b.version)
    expect(rows.map((r) => r.format)).toEqual(['CSV', 'TSV'])
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

    expect(await insertVersionIfHeld(db, claimed[0], { resourceId, ...created })).toBe(false)
    expect(await versions()).toEqual([])
  })

  it('drops the write-ahead record in the same statement', async () => {
    // The row references the object once this lands, so the record has done its
    // job (ADR-045 §4). In a second statement, a process that died in between
    // left a record naming a key something already referenced — repaired by the
    // sweep, but an hour later and for no reason.
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at) VALUES (${created.storageKey}, NOW())
    `)

    expect(await insertVersionIfHeld(db, null, { resourceId, ...created })).toBe(true)

    const ledger = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect(ledger.rows).toEqual([])
  })

  it('keeps the write-ahead record when the claim is gone', async () => {
    // The object is garbage rather than a version, and the record is what has
    // the sweep collect it.
    await db.insert(resourcePipeline).values({ resourceId })
    const { claimed } = await claimResources(
      db,
      [resourceId],
      randomUUID(),
      CLAIM_STALE_AFTER_MS,
      'run'
    )
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at) VALUES (${created.storageKey}, NOW())
    `)
    await cancelResourceRun(db, resourceId)

    expect(await insertVersionIfHeld(db, claimed[0], { resourceId, ...created })).toBe(false)

    const ledger = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect(ledger.rows).toHaveLength(1)
  })

  it('records a version for a resource that has no pipeline row', async () => {
    // Not a missing claim: a run cannot start without that row either, so
    // there is nothing for the backfill to lose a race against.
    expect(await insertVersionIfHeld(db, null, { resourceId, ...created })).toBe(true)
    expect(await versions()).toHaveLength(1)
  })

  describe('setVersionSchemaIfHeld — the interpretation, written after (ADR-046)', () => {
    const schema = {
      rowCount: 2,
      columns: [{ name: 'id', type: 'integer' as const, nullable: false, nullCount: 0 }],
    }

    async function heldClaim() {
      await db.insert(resourcePipeline).values({ resourceId })
      const { claimed } = await claimResources(
        db,
        [resourceId],
        randomUUID(),
        CLAIM_STALE_AFTER_MS,
        'run'
      )
      return claimed[0]
    }

    it('fills in the schema of a version created without one', async () => {
      const claim = await heldClaim()
      await insertVersionIfHeld(db, claim, { resourceId, ...created })
      expect(((await versions())[0] as { schema: unknown }).schema).toBeNull()

      expect(
        await setVersionSchemaIfHeld(db, claim, {
          resourceId,
          version: 1,
          schema,
          noTableReason: null,
        })
      ).toBe(true)
      expect(((await versions())[0] as { schema: unknown }).schema).toEqual(schema)
    })

    it('writes nothing once the run has been stopped', async () => {
      // The row outlives the run, so a displaced run must not describe it —
      // the same rule the insert follows (ADR-044 §4).
      const claim = await heldClaim()
      await insertVersionIfHeld(db, claim, { resourceId, ...created })
      await cancelResourceRun(db, resourceId)

      expect(
        await setVersionSchemaIfHeld(db, claim, {
          resourceId,
          version: 1,
          schema,
          noTableReason: null,
        })
      ).toBe(false)
      expect(((await versions())[0] as { schema: unknown }).schema).toBeNull()
    })

    it('records why an empty schema is empty', async () => {
      // The empty schema takes the version out of the pending set; the reason
      // is what answers "why is there no preview?" — and it has to sit beside
      // the fact it explains, on the version, or the answer depends on which
      // caller happened to interpret it (#277).
      const claim = await heldClaim()
      await insertVersionIfHeld(db, claim, { resourceId, ...created })

      expect(
        await setVersionSchemaIfHeld(db, claim, {
          resourceId,
          version: 1,
          schema: { rowCount: 0, columns: [] },
          noTableReason: 'too-large',
        })
      ).toBe(true)
      const [row] = await versions()
      expect((row as { noTableReason: string | null }).noTableReason).toBe('too-large')
    })

    it('works out "too large" from the cap rather than reading it off the row', async () => {
      // Nothing interprets an over-cap version, so the row has nothing to say.
      // Persisting the verdict would settle it: raise the cap and the version
      // would still claim to be too large, with an UPDATE nobody would run.
      await addVersion(1, 'sha256:v1')
      await db
        .update(resourceVersion)
        .set({ size: MAX_PARQUET_SOURCE_SIZE + 1 })
        .where(eq(resourceVersion.version, 1))

      expect((await service.getVersion(resourceId, 1)).noTableReason).toBe('too-large')

      await db
        .update(resourceVersion)
        .set({ size: MAX_PARQUET_SOURCE_SIZE })
        .where(eq(resourceVersion.version, 1))

      expect((await service.getVersion(resourceId, 1)).noTableReason).toBeNull()
    })

    it('reports a version that is not there', async () => {
      expect(
        await setVersionSchemaIfHeld(db, null, {
          resourceId,
          version: 7,
          schema,
          noTableReason: null,
        })
      ).toBe(false)
    })
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
    const result = await revertFromLive(deps)

    expect(result).toEqual({ cancelled: true, restored: 1, cleared: true, queued: true })
    // The pointer lands on v1's own object; nothing is copied to carry it.
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(getVersionKey(packageId, resourceId, 1, 'v'))
    expect(res.storageKey).not.toBe(liveKey)
    expect(res.hash).toBe('sha256:v1')
    // Derivatives describing the retracted content go now, and are rebuilt.
    expect(deps.search.deleteContent).toHaveBeenCalledWith(resourceId)
    expect(deps.queue.enqueue).toHaveBeenCalled()
  })

  it('points the cached interpretation at the version it restored', async () => {
    // The columns live on the version, so the restore has them: waiting for the
    // rebuild leaves `getSchema` answering with the retracted version's columns,
    // and the suggestion path reads it without the preview key whose absence
    // makes the query path refuse.
    await addVersion(1, 'sha256:v1', 'active', 'csv', columns('a'))
    await db
      .insert(resourcePipeline)
      .values({ resourceId, metadata: { schema: columns('a', 'b', 'c'), sourceHash: 'sha256:v2' } })

    await revertFromLive()

    expect(await cachedInterpretation()).toEqual({
      schema: columns('a'),
      // The proof it describes the bytes now live — readers compare it to
      // `resource.hash`, which the restore just moved.
      sourceHash: 'sha256:v1',
    })
  })

  it('leaves no interpretation when the restored version has none', async () => {
    // Non-tabular, or never interpreted. Keeping the old columns would describe
    // this content as something it is not.
    await addVersion(1, 'sha256:v1')
    await db
      .insert(resourcePipeline)
      .values({ resourceId, metadata: { schema: columns('a', 'b'), sourceHash: 'sha256:v2' } })

    await revertFromLive()

    expect(await cachedInterpretation()).toEqual({})
  })

  it('leaves no interpretation when the resource is emptied', async () => {
    await db
      .insert(resourcePipeline)
      .values({ resourceId, metadata: { schema: columns('a'), sourceHash: 'sha256:v2' } })

    const result = await revertFromLive()

    expect(result.restored).toBeNull()
    expect(await cachedInterpretation()).toEqual({})
  })

  it('parks the retracted object rather than deleting it', async () => {
    // Unwanted, not illegal — a reader that already resolved the key deserves
    // to finish. Destroying it is the rung above.
    await addVersion(1, 'sha256:v1')

    const deps = mockDeps()
    await revertFromLive(deps)

    expect(deps.storage.delete).not.toHaveBeenCalledWith(liveKey)
    const parked = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect((parked.rows as unknown as { key: string }[]).map((r) => r.key)).toContain(liveKey)
  })

  it('empties the resource when no version survives to restore', async () => {
    // A first upload that was wrong: there is nothing to go back to, and
    // leaving it live would be the one thing the caller asked against.
    const deps = mockDeps()
    const result = await revertFromLive(deps)

    expect(result.restored).toBeNull()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBeNull()
    expect(res.hash).toBeNull()
    // Nothing to rebuild from.
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('reports when there was no run to stop', async () => {
    await addVersion(1, 'sha256:v1')

    expect((await revertFromLive()).cancelled).toBe(false)
  })

  it('leaves a version created from the retracted content alone', async () => {
    // The ladder: destroying that version is a purge, which this deliberately
    // is not. Reverting the pointer must not quietly delete version rows.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')

    await revertFromLive()

    expect((await service.listByResource(resourceId)).map((v) => v.version)).toEqual([2, 1])
  })

  it('does not go back to the content it is retracting', async () => {
    // The run being stopped may have created the new file as a version moments
    // before. Restoring that is going nowhere: the caller asked for this file to
    // stop being live, and it would still be live with a version number quoted
    // back at them (ADR-044 §4).
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:live') // created from the file being retracted
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))

    const result = await revertFromLive()

    expect(result.restored).toBe(1)
  })

  it('steps back one version at a time', async () => {
    // What a revert is: the history walked backwards from where the content is
    // standing, not "the newest version that is not this one".
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await addVersion(3, 'sha256:v3')
    await db.update(resource).set({ hash: 'sha256:v3' }).where(eq(resource.id, resourceId))

    expect((await revertFromLive()).restored).toBe(2)
    expect((await revertFromLive()).restored).toBe(1)
  })

  it('puts the format back with the content (ADR-046 §6)', async () => {
    // A version is those bytes read under that format, so restoring one
    // restores both. Left behind, the label describes recovered content by a
    // rule never applied to it — and the version gate, comparing the label
    // against the highest active version's, files the same bytes again.
    await addVersion(1, 'sha256:v1', 'active', 'CSV')
    await addVersion(2, 'sha256:v2', 'active', 'TSV')
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))

    expect((await revertFromLive()).restored).toBe(1)

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.format).toBe('CSV')
    expect(res.hash).toBe('sha256:v1')
  })

  it('reports a completed revert whose cleanup failed, rather than failing it', async () => {
    // A revert is relative to where the content is standing, so it is not
    // retryable once the pointer has moved: a caller that reads this as failed
    // and tries again steps off the version this one restored. Here that would
    // empty the resource.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const deps = { ...mockDeps(), logger: silentLogger }
    vi.mocked(deps.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))

    const result = await revertFromLive(deps)

    expect(result.restored).toBe(1)
    expect(result.cleared).toBe(false)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')
  })

  it('reports a completed revert whose rebuild could not be queued', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const deps = { ...mockDeps(), logger: silentLogger }
    vi.mocked(deps.queue.enqueue).mockRejectedValueOnce(new Error('queue is down'))

    const result = await revertFromLive(deps)

    // The two halves answer separately: the derivatives did go, and only the
    // rebuild that puts them back never reached the queue.
    expect(result).toMatchObject({ restored: 1, cleared: true, queued: false })
  })

  it('leaves the versions active when the restore does not complete', async () => {
    // The marks and the pointer are one transaction now — the storage copy that
    // used to sit between them is gone (ADR-043 §1) — so a restore that does not
    // finish never commits the step-off, rather than putting it back by hand.
    // Left behind, the resource would serve content whose version is no longer
    // the highest active one, and nothing re-runs a revert to repair it.
    //
    // Failed from a trigger because that window has no seam left in the
    // application: both writes are the database's, and nothing of ours runs
    // between them.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const [before] = await db.select().from(resource).where(eq(resource.id, resourceId))
    await db.execute(sql`
      CREATE FUNCTION fail_mid_revert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'restore interrupted'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_mid_revert AFTER UPDATE ON resource_version
      FOR EACH ROW WHEN (NEW.state = 'superseded') EXECUTE FUNCTION fail_mid_revert();
    `)

    const deps = mockDeps()
    try {
      // Drizzle wraps the driver error, so the match is on the statement that
      // failed rather than on the message the trigger raised.
      await expect(revertFromLive(deps)).rejects.toThrow(/resource_version/)
    } finally {
      await db.execute(sql`
        DROP TRIGGER fail_mid_revert ON resource_version;
        DROP FUNCTION fail_mid_revert();
      `)
    }

    // Rolled back with the transaction, not by a second statement.
    const states = (await service.listByResource(resourceId)).map((v) => v.state)
    expect(states).toEqual(['active', 'active'])
    const [after] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(after.storageKey).toBe(before.storageKey)
    // Nothing downstream ran on a retraction that did not happen.
    expect(deps.search.deleteContent).not.toHaveBeenCalled()
  })

  it('lands a resend in the same place instead of stepping back again', async () => {
    // The failure no care inside the method reaches: the pointer moved, then the
    // response was lost. Naming the destination rather than a number of rungs is
    // what makes the second call the same call — relative, it would step off v1
    // and empty the resource.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }

    const first = await service.revertLiveContent(resourceId, request, mockDeps())
    const resent = await service.revertLiveContent(resourceId, request, mockDeps())

    expect(first.restored).toBe(1)
    expect(resent.restored).toBe(1)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')
  })

  it('leaves the restored derivatives alone on a resend', async () => {
    // A resend arriving after the rebuild finished would otherwise delete the
    // preview and indexed text of the content it just restored. Durability for
    // a failed cleanup comes from parking the keys, not from doing it again.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    await service.revertLiveContent(resourceId, request, mockDeps())

    const resent = mockDeps()
    expect((await service.revertLiveContent(resourceId, request, resent)).restored).toBe(1)

    expect(resent.storage.deleteMany).not.toHaveBeenCalled()
    expect(resent.search.deleteContent).not.toHaveBeenCalled()
    // The rebuild is queued again, though: reaching the destination says nothing
    // about whether the attempt that got there managed to queue one, and a
    // rebuild repeated over content already in place costs a pass.
    expect(resent.queue.enqueue).toHaveBeenCalled()
  })

  it('refuses a request overtaken by content its caller never saw', async () => {
    // The reason idempotency alone is not enough. The request was prepared
    // against v2; by the time it lands the resource is serving something newer,
    // and honouring it would retract that instead.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)

    // Something else publishes in the meantime, minting a new generation.
    await db
      .update(resource)
      .set({ hash: 'sha256:v3', contentRevision: randomUUID() })
      .where(eq(resource.id, resourceId))

    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: revertTarget, ifLiveRevision: liveRevision },
        mockDeps()
      )
    ).rejects.toThrow(/has changed/)
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v3')
  })

  it('does not stop the run producing the content that overtook it', async () => {
    // Taking the claim is what stops a run, so a request that is going to be
    // refused must be refused *before* it — otherwise being told no costs the
    // newer content the run that was building it.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    await db
      .update(resource)
      .set({ hash: 'sha256:v3', contentRevision: randomUUID() })
      .where(eq(resource.id, resourceId))
    const run = await startRun()

    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: revertTarget, ifLiveRevision: liveRevision },
        mockDeps()
      )
    ).rejects.toThrow(/has changed/)

    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe.claimOwner).toBe(run)
    expect(pipe.status).not.toBe('cancelled')
  })

  it('does not stop the rebuild a resend arrives during', async () => {
    // The resend has nothing to do, so it must not cost the run that the first
    // attempt queued — which it would, since taking the claim is the stop, and
    // nothing moves afterwards to re-queue it.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    await service.revertLiveContent(resourceId, request, mockDeps())
    const run = await startRun()

    expect((await service.revertLiveContent(resourceId, request, mockDeps())).restored).toBe(1)

    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe.claimOwner).toBe(run)
    expect(pipe.status).not.toBe('cancelled')
  })

  it('clears what the retracted content left behind when the resource is empty', async () => {
    // The one case reprocessing cannot repair: there is no content to rebuild
    // from, and for an external URL a reprocess would fetch the retracted file
    // straight back. Deleting is unconditionally right here — nothing else
    // describes an empty resource — so the resend is the repair.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))

    const first = await service.revertLiveContent(resourceId, request, failing)
    // Nothing to queue against an emptied resource, so that half is null.
    expect(first).toMatchObject({ restored: null, cleared: false, queued: null })

    const resent = mockDeps()
    expect((await service.revertLiveContent(resourceId, request, resent)).cleared).toBe(true)
    expect(resent.search.deleteContent).toHaveBeenCalledWith(resourceId)
  })

  it('refuses an upload that landed after the claim was taken', async () => {
    // The takeover checked the generation, but an upload takes no claim
    // (ADR-044 §6) and can publish in the moment after — and then the pointer
    // CAS would agree, retracting content the caller never saw.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    // Stand in for that window: the generation the takeover matched is gone by
    // the time the content is read.
    const deps = mockDeps()
    vi.mocked(deps.storage.copy).mockImplementation(async () => {
      throw new Error('should not have copied')
    })
    await db
      .update(resource)
      .set({ contentRevision: randomUUID() })
      .where(eq(resource.id, resourceId))

    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: revertTarget, ifLiveRevision: liveRevision },
        deps
      )
    ).rejects.toThrow(/has changed/)
    expect(deps.storage.copy).not.toHaveBeenCalled()
  })

  it('queues a rebuild rather than an ordinary run', async () => {
    // An ordinary run re-reads an external URL. Reverted because that URL served
    // the wrong thing, the job queued to finish the retraction would publish it
    // straight back.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const deps = mockDeps()

    await revertFromLive(deps)

    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ rebuildOnly: true })
    )
  })

  it('queues the rebuild a lost attempt never managed to', async () => {
    // Reaching the destination says nothing about whether the attempt that got
    // there queued the rebuild. Reporting success on the strength of position
    // alone leaves the preview and index missing for good.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.queue.enqueue).mockRejectedValueOnce(new Error('queue is down'))
    expect((await service.revertLiveContent(resourceId, request, failing)).queued).toBe(false)

    const resent = mockDeps()
    expect((await service.revertLiveContent(resourceId, request, resent)).queued).toBe(true)
    expect(resent.queue.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ rebuildOnly: true })
    )
  })

  it('does not stop a run to reject an invalid destination', async () => {
    // The rejection is decidable without touching anything, so deciding it
    // after the claim costs the running job for nothing.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2', 'superseded')
    const { liveRevision } = await service.revertContext(resourceId)
    const run = await startRun()

    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: 2, ifLiveRevision: liveRevision },
        mockDeps()
      )
    ).rejects.toThrow(/superseded/)

    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe.claimOwner).toBe(run)
    expect(pipe.status).not.toBe('cancelled')
  })

  it('holds a resource that had no pipeline row before cleaning it', async () => {
    // Claiming a set that holds nothing still runs the callback, so without a
    // row this would clean unheld — and the search delete has no generation to
    // condition on the way the DB write does.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))
    await db.delete(resourcePipeline).where(eq(resourcePipeline.resourceId, resourceId))
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))
    await service.revertLiveContent(resourceId, request, failing)
    await db.delete(resourcePipeline).where(eq(resourcePipeline.resourceId, resourceId))

    const resent = mockDeps()
    expect((await service.revertLiveContent(resourceId, request, resent)).cleared).toBe(true)

    // A row now exists to have been claimed, and it was released again. Its
    // status says what it is — nothing queued, nothing run — rather than
    // claiming a run was cancelled, which a screen answers by offering the
    // reprocess that would fetch the withdrawn content back.
    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe).toBeDefined()
    expect(pipe.claimOwner).toBeNull()
    expect(pipe.status).toBe('pending')
  })

  it('holds a resource that had no pipeline row while it reverts', async () => {
    // The row is the claim, so without one the revert ran unheld — and a
    // `/run-pipeline` arriving a moment later would create and index the very
    // content being retracted. For an upload that is undetectable downstream:
    // its fetch republishes the same key, so the pointer CAS sees nothing.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await db.delete(resourcePipeline).where(eq(resourcePipeline.resourceId, resourceId))

    expect((await revertFromLive()).restored).toBe(1)

    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe).toBeDefined()
    expect(pipe.claimOwner).toBeNull()
  })

  it('does not stop the run that is about to fill an emptied resource', async () => {
    // The generation cannot see this one: a fetch that has not published yet
    // leaves the resource empty and its generation untouched, so a takeover
    // would cancel the very run that was about to fill it — and nothing here
    // re-queues it. Claimed as a job instead, which refuses rather than takes.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))
    await service.revertLiveContent(resourceId, request, failing)
    const run = await startRun()

    const resent = mockDeps()
    await service.revertLiveContent(resourceId, request, resent)

    const [pipe] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(pipe.claimOwner).toBe(run)
    expect(pipe.status).not.toBe('cancelled')
    // The run will write its own derivatives, so this had nothing to do.
    expect(resent.search.deleteContent).not.toHaveBeenCalled()
  })

  it('leaves a refilled resource alone when an empty resend arrives late', async () => {
    // The resend read "empty" and is about to delete what describes it — but an
    // upload landed in between, so those derivatives are the new content's.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const request = { restoreTo: revertTarget, ifLiveRevision: liveRevision }
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))
    await service.revertLiveContent(resourceId, request, failing)

    // Something uploads: the resource is no longer empty, and its generation moved.
    await db
      .update(resource)
      .set({ storageKey: liveKey, hash: 'sha256:new', contentRevision: randomUUID() })
      .where(eq(resource.id, resourceId))

    const resent = mockDeps()
    await expect(service.revertLiveContent(resourceId, request, resent)).rejects.toThrow(
      /has changed/
    )
    expect(resent.storage.deleteMany).not.toHaveBeenCalled()
    expect(resent.search.deleteContent).not.toHaveBeenCalled()
  })

  it('refuses a destination the resource cannot stand on', async () => {
    // Unchecked, this supersedes everything above the named version and then
    // restores whichever one is newest active — a different version, or none —
    // and reports success.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await addVersion(3, 'sha256:v3', 'superseded')
    await db.update(resource).set({ hash: 'sha256:v2' }).where(eq(resource.id, resourceId))
    const { liveRevision } = await service.revertContext(resourceId)

    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: 3, ifLiveRevision: liveRevision },
        mockDeps()
      )
    ).rejects.toThrow(/superseded/)
    await expect(
      service.revertLiveContent(
        resourceId,
        { restoreTo: 9, ifLiveRevision: liveRevision },
        mockDeps()
      )
    ).rejects.toThrow(/not found/i)

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v2')
  })

  it('marks the version it stepped off as superseded', async () => {
    // Its content survives — destroying it is a purge, which this deliberately
    // is not — but it stops being a candidate for anything that asks "what is
    // live": the restore, a second revert, the version gate, the purge.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')

    await revertFromLive()

    const views = await service.listByResource(resourceId)
    expect(views.map((v) => [v.version, v.state])).toEqual([
      [2, 'superseded'],
      [1, 'active'],
    ])
  })

  it('leaves the restored content on the highest active version', async () => {
    // What the pipeline's change gate compares against (ADR-043). Left active,
    // the stepped-off version would still outrank the restored one, its hash
    // would not match the restored content, and the run this revert enqueues
    // would create a v3 of bytes that are already v1 — which a second revert
    // would then step off, landing back on v2 and handing back what the first
    // one retracted.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')

    await revertFromLive()

    // Newest-first, so the first active row is the highest one.
    const highest = (await service.listByResource(resourceId)).find((v) => v.state === 'active')
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(highest?.hash).toBe(res.hash)
  })

  it('does not step forward into a version an earlier revert stepped off', async () => {
    // Choosing by "not the current content" alone, the second revert would find
    // v2 the newest version that is not v1 and hand back exactly what the first
    // one retracted.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')

    expect((await revertFromLive()).restored).toBe(1)
    const second = await revertFromLive()

    expect(second.restored).toBeNull()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).not.toBe('sha256:v2')
    expect(res.storageKey).toBeNull()
  })

  it('empties the resource when the only version holds the retracted content', async () => {
    // v1 was created from the wrong file itself: there is nothing behind it,
    // and leaving it live is the one thing the caller asked against.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))

    const result = await revertFromLive()

    expect(result.restored).toBeNull()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBeNull()
  })

  it('parks the object it empties the resource of', async () => {
    // Emptying moves the same pointer as every other write, so what it replaces
    // is parked the same way (ADR-043) — unconditionally cleared, the retracted
    // object would be tracked by nothing.
    await revertFromLive()

    const parked = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect((parked.rows as unknown as { key: string }[]).map((r) => r.key)).toContain(liveKey)
  })

  it('does not empty the resource when live stands on a version being purged', async () => {
    // A claimed purge moves its version to `purging`, and live goes on standing
    // on that object until the worker runs. Asked "which active version is
    // live", the answer is none — not the older version that happens to share
    // the hash, which the copying path makes routine. Told the latter, a revert
    // computes a destination below it and steps off everything, including the
    // only version left.
    const v1Key = getVersionKey(packageId, resourceId, 1, 'v')
    const v2Key = getVersionKey(packageId, resourceId, 2, 'v')
    await addVersion(1, 'sha256:same')
    await addVersion(2, 'sha256:same', 'active', 'TSV')
    await db
      .update(resource)
      .set({ storageKey: v2Key, hash: 'sha256:same' })
      .where(eq(resource.id, resourceId))
    await service.claimPurge(resourceId, 2, userId, 'illegal content')

    const { revertTarget, liveRevision } = await service.revertContext(resourceId)

    // No active version is being stood on, so a revert lands on the newest one
    // there is — v1. Answering "standing on v1" instead puts the destination
    // below it, which is null: empty the resource, destroying the only content
    // that would have survived the purge.
    expect(revertTarget).toBe(1)

    const deps = mockDeps()
    await service.revertLiveContent(
      resourceId,
      { restoreTo: revertTarget, ifLiveRevision: liveRevision },
      deps
    )

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(v1Key)
    expect(res.storageKey).not.toBe(v2Key)
  })

  it('does not report a restore it lost, nor delete the winner derivatives', async () => {
    // Uploads take no claim (ADR-044 §6), so the live pointer can move while a
    // revert runs. Calling that a restore would delete the preview and the
    // indexed content of whatever won. Driven from a trigger: the pointer move
    // has to land inside the revert's transaction, and nothing of ours runs
    // between its two writes.
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    await db.execute(sql`
      CREATE FUNCTION steal_pointer_mid_restore() RETURNS trigger AS $$
      BEGIN
        UPDATE resource SET storage_key = 'resources/pkg/winner', hash = 'sha256:winner'
        WHERE id = NEW.resource_id;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER steal_pointer_mid_restore AFTER UPDATE ON resource_version
      FOR EACH ROW WHEN (NEW.state = 'superseded') EXECUTE FUNCTION steal_pointer_mid_restore();
    `)

    const deps = mockDeps()
    try {
      await expect(revertFromLive(deps)).rejects.toThrow(/changed/)
    } finally {
      await db.execute(sql`
        DROP TRIGGER steal_pointer_mid_restore ON resource_version;
        DROP FUNCTION steal_pointer_mid_restore();
      `)
    }

    expect(deps.search.deleteContent).not.toHaveBeenCalled()
  })

  it('holds the resource for the whole revert', async () => {
    // Cancelling and then claiming leaves the resource free in between, long
    // enough for a waiting job to start writing over what is being retracted.
    const [pipe] = await db.insert(resourcePipeline).values({ resourceId }).returning()
    await addVersion(1, 'sha256:v1')

    let heldDuringRestore = false
    const deps = mockDeps()
    // Observed where the revert still reaches outside the database — discarding
    // the derivatives, which runs under the same claim as the restore.
    vi.mocked(deps.search.deleteContent).mockImplementation(async () => {
      const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
      heldDuringRestore = row.claimOwner !== null
    })

    await revertFromLive(deps)

    expect(heldDuringRestore).toBe(true)
    const [after] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipe.id))
    expect(after.claimOwner).toBeNull()
  })

  it('refuses while a purge holds the resource', async () => {
    await db.insert(resourcePipeline).values({ resourceId })
    await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS, 'job')
    await addVersion(1, 'sha256:v1')

    await expect(revertFromLive()).rejects.toThrow(/being processed/)
  })
})

describe('repairDerivatives — the repair a screen can offer (ADR-044 §4)', () => {
  it('queues a rebuild when there is content to rebuild from', async () => {
    await addVersion(1, 'sha256:v2')
    const deps = mockDeps()

    expect(await service.repairDerivatives(resourceId, deps)).toEqual({
      queued: true,
      cleared: null,
    })
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ rebuildOnly: true })
    )
  })

  it('clears the leftovers instead when the resource is empty', async () => {
    // Queueing a run here only fails — Fetch has no object to measure — so the
    // repair the screen offers would be guaranteed to do nothing.
    await addVersion(1, 'sha256:live')
    await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, resourceId))
    const { revertTarget, liveRevision } = await service.revertContext(resourceId)
    const failing = { ...mockDeps(), logger: silentLogger }
    vi.mocked(failing.search.deleteContent).mockRejectedValueOnce(new Error('search is down'))
    await service.revertLiveContent(
      resourceId,
      { restoreTo: revertTarget, ifLiveRevision: liveRevision },
      failing
    )

    const repair = mockDeps()
    // Null, not false: nothing was owed, so a caller reading the outcome does
    // not take this for a repair that failed.
    expect(await service.repairDerivatives(resourceId, repair)).toEqual({
      queued: null,
      cleared: true,
    })
    expect(repair.queue.enqueue).not.toHaveBeenCalled()
    expect(repair.search.deleteContent).toHaveBeenCalledWith(resourceId)
  })
})

describe('the artifacts derived from retracted content', () => {
  // The preview lives in a column, the text head inside `metadata` (ADR-040).
  // Being referenced there, the sweep leaves the text head alone — so whatever
  // retracts the content has to destroy it, or an extract of it stays in the
  // bucket and stays readable through the suggestion path.
  const PREVIEW = 'previews/pkg/res.tok.parquet'
  const TEXT_HEAD = 'previews/pkg/res.tok.txt'

  async function withArtifacts() {
    await db.insert(resourcePipeline).values({
      resourceId,
      previewKey: PREVIEW,
      metadata: { textHeadKey: TEXT_HEAD, contentIndexed: true },
    })
  }

  async function pipelineRow() {
    const [row] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    return row
  }

  it('are destroyed when the live version is purged', async () => {
    await withArtifacts()
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2')
    const deps = mockDeps()
    await service.claimPurge(resourceId, 2, userId, 'legal')

    await service.executePurge(resourceId, 2, deps)

    expect(vi.mocked(deps.storage.deleteMany).mock.calls[0][0].sort()).toEqual(
      [PREVIEW, TEXT_HEAD].sort()
    )
    const row = await pipelineRow()
    expect(row.previewKey).toBeNull()
    // The text head is gone with the rest, and the row stops claiming an index
    // whose documents this just deleted
    expect(row.metadata).toEqual({ contentIndexed: false })
  })

  it('are destroyed by a revert', async () => {
    // The caller asked for this file to stop being served; what describes it
    // goes now rather than when the pipeline gets round to replacing it.
    await withArtifacts()
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()

    await revertFromLive(deps)

    expect(vi.mocked(deps.storage.deleteMany).mock.calls[0][0].sort()).toEqual(
      [PREVIEW, TEXT_HEAD].sort()
    )
    expect((await pipelineRow()).metadata).toEqual({ contentIndexed: false })
  })

  it('leaves a pointer another run has moved on', async () => {
    // A run taken over for being stale can write a newer preview while this is
    // deleting. Clearing that one would leave its object named by nothing.
    await withArtifacts()
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()
    vi.mocked(deps.storage.deleteMany).mockImplementation(async (keys: string[]) => {
      await db
        .update(resourcePipeline)
        .set({ previewKey: 'previews/pkg/res.newer.parquet' })
        .where(eq(resourcePipeline.resourceId, resourceId))
      return keys
    })

    await revertFromLive(deps)

    expect((await pipelineRow()).previewKey).toBe('previews/pkg/res.newer.parquet')
  })

  it('does nothing when there are none', async () => {
    await db.insert(resourcePipeline).values({ resourceId })
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()

    await revertFromLive(deps)

    expect(deps.storage.deleteMany).not.toHaveBeenCalled()
  })
})
