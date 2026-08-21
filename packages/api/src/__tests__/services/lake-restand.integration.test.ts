/**
 * The one operation left that moves a DuckLake table's contents without
 * publishing a version — a purge coming off the version it retracted (spec §9.1
 * step 4) — against real PostgreSQL with the DuckLake calls stubbed.
 *
 * What the stubs are for: which version the purge stands the table on, and that
 * it stands it there without writing anything back. Every version row keeps the
 * snapshot its own ingest wrote (spec §7.2), so the assertions are as much about
 * the rows left alone as about the call made. DuckLake's own behaviour is
 * covered where it lives.
 *
 * A file of its own because the module mock is hoisted over the whole file, and
 * the neighbouring revert and purge cases prove the opposite thing — that an
 * unreachable lake is reported rather than thrown.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { createLogger, getStorageKey } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import {
  withLakeSession,
  lakeTableExists,
  restandLakeTable,
  lakeTableName,
  dropLakeTable,
  resolvableSnapshots,
  reclaimUnreferencedSnapshots,
} from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { ResourceVersionService } from '../../services/resource-version-service'
import { unreachableLake } from '../test-helpers/fixtures'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return {
    ...actual,
    withLakeSession: vi.fn(actual.withLakeSession),
    lakeTableExists: vi.fn(actual.lakeTableExists),
    restandLakeTable: vi.fn(actual.restandLakeTable),
    dropLakeTable: vi.fn(actual.dropLakeTable),
    resolvableSnapshots: vi.fn(actual.resolvableSnapshots),
    reclaimUnreferencedSnapshots: vi.fn(actual.reclaimUnreferencedSnapshots),
  }
})

const db = getTestDb()
const silentLogger = createLogger({ name: 'test', level: 'silent' })
const service = new ResourceVersionService(db)

let packageId: string
let resourceId: string

function mockDeps() {
  return {
    storage: {
      copy: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockImplementation((keys: string[]) => Promise.resolve(keys)),
    } as unknown as StorageAdapter,
    search: { deleteContent: vi.fn() } as unknown as SearchAdapter,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as unknown as QueueAdapter,
    lake: unreachableLake,
    logger: silentLogger,
  }
}

async function addVersion(version: number, hash: string, snapshotId: number) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 100 + version,
    hash,
    origin: 'upload',
    state: 'active',
    format: 'csv',
    ducklakeSnapshotId: snapshotId,
  })
}

async function versionRow(version: number) {
  const [row] = await db
    .select({ state: resourceVersion.state, snapshot: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
  return row
}

const snapshotOf = async (version: number) => (await versionRow(version))?.snapshot ?? null
const stateOf = async (version: number) => (await versionRow(version))?.state

/** Put the pointer on a version, which is what a revert or purge reads as live. */
async function liveOn(version: number) {
  await db
    .update(resource)
    .set({
      storageKey: getStorageKey(packageId, resourceId, `v${version}`),
      hash: `sha256:v${version}`,
    })
    .where(eq(resource.id, resourceId))
}

/** Take a version back out of the lake, for the shapes where one never got in. */
async function unIngest(version: number) {
  await db
    .update(resourceVersion)
    .set({ ducklakeSnapshotId: null })
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
}

/** v3 live and in the lake, above whatever the case has done to v1 and v2. */
async function v3LiveAndIngested() {
  await addVersion(3, 'sha256:v3', 11)
  await liveOn(3)
}

/**
 * v1 in the lake, v2 never taken, v3 in the lake and live — the shape where
 * layer 2's target and layer 1's are two versions apart, whichever of the two
 * moves the table.
 */
async function v2NeverTaken() {
  await unIngest(2)
  await v3LiveAndIngested()
}

async function revertTo(version: number) {
  const { liveRevision } = await service.revertContext(resourceId)
  return service.revertLiveContent(
    resourceId,
    { restoreTo: version, ifLiveRevision: liveRevision },
    mockDeps()
  )
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-reconcile', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const res = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload', hash: 'sha256:v2', size: 102 })
    .returning()
  resourceId = res[0].id

  // Call history as well as implementations: a stub set here keeps the calls
  // the last case made, and every assertion below counts them.
  vi.clearAllMocks()
  // A session object is never dereferenced: every call that would take one is
  // stubbed, so its only job is to be the same reference the assertions expect.
  const session = {} as LakeSession
  vi.mocked(withLakeSession).mockImplementation((_config, fn) => fn(session))
  vi.mocked(lakeTableExists).mockResolvedValue(true)
  vi.mocked(restandLakeTable).mockResolvedValue(undefined)
  vi.mocked(dropLakeTable).mockResolvedValue(undefined)
  vi.mocked(resolvableSnapshots).mockImplementation(async (_session, ids) => new Set(ids))
  vi.mocked(reclaimUnreferencedSnapshots).mockResolvedValue({ expired: 0, filesDeleted: 0 })

  // v1 and v2 both loaded, live standing on v2, so a revert lands on v1 with
  // v2's rows still in the table.
  await addVersion(1, 'sha256:v1', 5)
  await addVersion(2, 'sha256:v2', 9)
  await liveOn(2)
})

afterAll(async () => {
  await closeTestDb()
  vi.restoreAllMocks()
})

describe('a revert leaves DuckLake to the ingest (ADR-044 §4)', () => {
  it('moves no table and rewrites no version row', async () => {
    // **The reconcile a revert used to run is gone.** Publishing forward makes
    // the restored content an ordinary outstanding version, and the Lake step
    // merges it onto whatever the table holds — which is what the write path
    // ii-b adopted does anyway (spec §7.2). Moving the table here would be the
    // whole-table rewrite that path exists to avoid, and it would have to write
    // the landing snapshot onto a version row that is supposed to be
    // write-once.
    const result = await revertTo(1)

    expect(result).toMatchObject({ restored: 1, published: 3, cleared: true })
    expect(restandLakeTable).not.toHaveBeenCalled()
    // Both rows keep the snapshots their own content landed under.
    expect(await snapshotOf(1)).toBe(5)
    expect(await snapshotOf(2)).toBe(9)
    // And the version it published is what the sweep will pick up.
    expect(await snapshotOf(3)).toBeNull()
  })

  it('asks the repair for nothing afterwards', async () => {
    await revertTo(1)

    // Null, not true: nothing was owed, so a caller reading the outcome does
    // not take it for a repair that ran.
    expect(await service.repairDerivatives(resourceId, mockDeps())).toEqual({
      queued: true,
      cleared: null,
    })
    expect(restandLakeTable).not.toHaveBeenCalled()
  })
})

describe('a purge comes off the version layer 2 stands on (spec §9.1)', () => {
  async function purge(version: number, deps = mockDeps()) {
    await service.claimPurge(resourceId, version, TEST_USER_ID, 'illegal content')
    return service.executePurge(resourceId, version, deps)
  }

  it('stands the table on the newest version the lake took, not the newest one left', async () => {
    // v1 in the lake, v2 live but never taken — too large, not tabular, in ii-b
    // an unusable key — and v3 in the lake, being purged. Layer 1 falls back to
    // v2; reading that answer for layer 2 finds no snapshot there and drops the
    // table, and nothing puts its contents back: v1 still carries its snapshot id,
    // and the sweep only looks for versions without one.
    await v2NeverTaken()

    await purge(3)

    expect(restandLakeTable).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      table: lakeTableName(resourceId),
      // v1's own snapshot, two versions below where the pointer lands.
      snapshot: 5,
    })
    expect(dropLakeTable).not.toHaveBeenCalled()
    // And v1 still records where its *own* ingest landed. Writing the move back
    // here is what ii-b's `table_changes` and the whole of §7.2 rule out; the
    // landing snapshot is named by no version row, which §11-3 already covers.
    expect(await snapshotOf(1)).toBe(5)
  })

  it('drops the table when no surviving version reached the lake', async () => {
    await unIngest(1)
    await v2NeverTaken()

    await purge(3)

    expect(dropLakeTable).toHaveBeenCalledOnce()
    expect(restandLakeTable).not.toHaveBeenCalled()
  })

  it('reads where the table stands from the snapshots, not the version numbers', async () => {
    // What the conversion (ADR-044 §4) leaves behind: v1 carries an id the old
    // scheme's reconcile wrote, above v2's, so the table holds **v1's** rows
    // while v2 is the higher version. Purging v1 therefore has to step down —
    // going by version number it reads as "v2 is above me, nothing to do" and
    // leaves the purged rows as the table's current contents.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 13 })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))

    await purge(1)

    expect(restandLakeTable).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      table: lakeTableName(resourceId),
      snapshot: 9,
    })
  })

  it('keeps answering after a step-down, purging down a rewritten history', async () => {
    // **Two purges in a row over converted rows.** v1 carries an id the old
    // scheme wrote, above v2's, and v3 is an ordinary later load. Purging v3
    // stands the table down; purging v2 then has to know where that left it.
    //
    // Reading the target by version number is what breaks here: v3 would come
    // down onto v2 (the higher version), leaving the head on v2's rows while v1
    // still records the higher id — and the second purge, asking "was anything
    // loaded after me", would read v1@13 and leave the rows it just purged as
    // the table's contents. Stepping to the highest id instead keeps the head
    // and the question on the same version.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: 13 })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    await addVersion(3, 'sha256:v3', 14)
    await liveOn(3)

    await purge(3)

    expect(restandLakeTable).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      table: lakeTableName(resourceId),
      snapshot: 13,
    })

    vi.mocked(restandLakeTable).mockClear()
    await purge(2)

    // v2's rows are not what the table holds, so there is nothing to come off.
    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(dropLakeTable).not.toHaveBeenCalled()

    // And the version the head does hold is where the last purge goes.
    vi.mocked(restandLakeTable).mockClear()
    await purge(1)

    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(dropLakeTable).toHaveBeenCalledOnce()
  })

  it('leaves a table that is already gone alone', async () => {
    // Dropped by an earlier purge with nowhere to stand, or by a restore, while
    // the surviving versions keep their recorded ids. There is nothing to move
    // and nothing to make unfetchable — and standing a table that is not there
    // only fails, which would leave the purge stuck in `purging` for good.
    await v3LiveAndIngested()
    vi.mocked(lakeTableExists).mockResolvedValue(false)

    await purge(3)

    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(dropLakeTable).not.toHaveBeenCalled()
    expect(await stateOf(3)).toBe('purged')
  })

  it('steps past a recorded snapshot the catalog no longer resolves', async () => {
    // v2's id outlives the snapshot when a reclaim runs against an older catalog
    // (spec §11-5). Standing on it fails, and a failed purge is one left holding
    // what it retracted — so the walk goes down to a version that resolves.
    await v3LiveAndIngested()
    vi.mocked(resolvableSnapshots).mockImplementation(
      async (_session, ids) => new Set(ids.filter((id) => id !== 9))
    )

    await purge(3)

    expect(restandLakeTable).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      table: lakeTableName(resourceId),
      snapshot: 5,
    })
  })

  it('comes off a middle version the lake is still standing on', async () => {
    // v3 is live and was never taken, so the lake stands on v2 — a middle version
    // by the pointer's reckoning and the table's current contents all the same.
    // Left alone, the purged rows stay what a reader sees and what ii-b's MERGE
    // would build the next version on.
    await addVersion(3, 'sha256:v3', 11)
    await unIngest(3)
    await liveOn(3)

    await purge(2)

    expect(restandLakeTable).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      table: lakeTableName(resourceId),
      snapshot: 5,
    })
    expect(dropLakeTable).not.toHaveBeenCalled()
  })

  it('leaves the contents alone when a version outside the active set loaded after it', async () => {
    // What the table holds is whichever version loaded last, whatever state its
    // row is in now — a row the old scheme set aside (ADR-044 §4) among them.
    // Stepping v1 down here would take those rows off with it, and they are not
    // what this purge owes anything about. (A second *purging* version cannot
    // arise: the database allows one per resource.)
    await addVersion(3, 'sha256:v3', 11)
    await db
      .update(resourceVersion)
      .set({ state: 'superseded' })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 3)))
    await liveOn(1)

    await purge(1)

    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(dropLakeTable).not.toHaveBeenCalled()
  })

  it('leaves the contents alone for a middle version the lake has moved past', async () => {
    // v2 is live and in the lake, so the table already holds rows this purge does
    // not touch. Read off the version numbers, which order the snapshots now that
    // each is written once. The reclaim still runs — v1's own snapshot holds its
    // rows.
    await purge(1)

    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(dropLakeTable).not.toHaveBeenCalled()
    expect(reclaimUnreferencedSnapshots).toHaveBeenCalledOnce()
  })

  it('fails rather than dropping a table it has no resolvable version for', async () => {
    // Every recorded id outlives the snapshot it names (spec §11-5). Dropping
    // here would be permanent — those versions keep their ids, so the sweep
    // passes over them — so the purge stays `purging` where an operator can see
    // it and the worker retries, which is what happened before the walk existed.
    await v3LiveAndIngested()
    vi.mocked(resolvableSnapshots).mockResolvedValue(new Set())
    const deps = mockDeps()

    await expect(purge(3, deps)).rejects.toThrow(/resolves/)

    expect(dropLakeTable).not.toHaveBeenCalled()
    expect(restandLakeTable).not.toHaveBeenCalled()
    expect(await stateOf(3)).toBe('purging')
    // And the derivatives went first. A lake this purge cannot finish is the one
    // failure that leaves the preview and the search index as the last readable
    // copy of content whose layer-1 object is already deleted — so they must be
    // gone before it is attempted, not after (spec §9.1 steps 3 and 4).
    expect(deps.search.deleteContent).toHaveBeenCalledWith(resourceId)
  })
})
