/**
 * The reconcile that puts DuckLake back onto the version a revert restored
 * (ADR-043 §5), against real PostgreSQL with the DuckLake calls stubbed.
 *
 * What the stubs are for: the sequence under test is "roll back, read the
 * snapshot it landed on, record it against the version" — and it is the
 * recording that makes a second pass a no-op. DuckLake's own behaviour is
 * covered where it lives; what a running catalog cannot show here is that the
 * id reaches the row, and that nothing rolls back once it has.
 *
 * A file of its own because the module mock is hoisted over the whole file, and
 * the neighbouring revert cases prove the opposite thing — that an unreachable
 * lake is reported rather than thrown.
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
  rollbackLakeTable,
  ingestParquetVersion,
  lakeTableName,
} from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { ResourceVersionService } from '../../services/resource-version-service'
import { ingestVersionIntoLake, withLakeIngestLock } from '../../services/lake-ingest'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return {
    ...actual,
    withLakeSession: vi.fn(actual.withLakeSession),
    lakeTableExists: vi.fn(actual.lakeTableExists),
    rollbackLakeTable: vi.fn(actual.rollbackLakeTable),
    ingestParquetVersion: vi.fn(actual.ingestParquetVersion),
  }
})

const db = getTestDb()
const silentLogger = createLogger({ name: 'test', level: 'silent' })
const service = new ResourceVersionService(db)

/** The snapshot the stubbed rollback lands on — above every recorded one. */
const LANDED = 13

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

async function snapshotOf(version: number): Promise<number | null> {
  const [row] = await db
    .select({ id: resourceVersion.ducklakeSnapshotId })
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
  return row?.id ?? null
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
  await db
    .update(resource)
    .set({ storageKey: getStorageKey(packageId, resourceId, 'v2') })
    .where(eq(resource.id, resourceId))

  // Call history as well as implementations: a stub set here keeps the calls
  // the last case made, and every assertion below counts them.
  vi.clearAllMocks()
  // A session object is never dereferenced: every call that would take one is
  // stubbed, so its only job is to be the same reference the assertions expect.
  const session = {} as LakeSession
  vi.mocked(withLakeSession).mockImplementation((_config, fn) => fn(session))
  vi.mocked(lakeTableExists).mockResolvedValue(true)
  vi.mocked(rollbackLakeTable).mockResolvedValue(LANDED)

  // v1 and v2 both loaded, live standing on v2, so a revert lands on v1 with
  // v2's rows still in the table.
  await addVersion(1, 'sha256:v1', 5)
  await addVersion(2, 'sha256:v2', 9)
})

afterAll(async () => {
  await closeTestDb()
  vi.restoreAllMocks()
})

async function revertToV1() {
  const { liveRevision } = await service.revertContext(resourceId)
  return service.revertLiveContent(
    resourceId,
    { restoreTo: 1, ifLiveRevision: liveRevision },
    mockDeps()
  )
}

describe('reconciling DuckLake with the restored version (ADR-043 §5)', () => {
  it('rolls the table onto the restored version and records where it landed', async () => {
    const result = await revertToV1()

    expect(result).toMatchObject({ restored: 1, cleared: true })
    expect(rollbackLakeTable).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      lakeTableName(resourceId),
      // v1's own snapshot: the contents to put back, not where they land.
      5
    )
    // Recorded on the restored version, not the one stepped off — this is what
    // later readers use to tell the table is already standing where it should.
    expect(await snapshotOf(1)).toBe(LANDED)
    expect(await snapshotOf(2)).toBe(9)
  })

  it('rolls nothing back the second time', async () => {
    await revertToV1()
    vi.mocked(rollbackLakeTable).mockClear()

    // The repair is the other caller, and the one a failed reconcile lands on.
    const repair = await service.repairDerivatives(resourceId, mockDeps())

    // Null, not true: there was nothing owed, so a caller reading the outcome
    // does not take this for a repair that ran.
    expect(repair).toEqual({ queued: true, cleared: null })
    expect(rollbackLakeTable).not.toHaveBeenCalled()
  })

  it('leaves the recorded snapshot alone when the rollback fails', async () => {
    vi.mocked(rollbackLakeTable).mockRejectedValueOnce(new Error('catalog is down'))

    const result = await revertToV1()

    // Reported, not thrown: the retraction has already happened.
    expect(result).toMatchObject({ restored: 1, cleared: false })
    // Still v1's own, so the next caller does the rollback again rather than
    // reading a table that never moved as settled.
    expect(await snapshotOf(1)).toBe(5)
  })
})

describe('an ingest builds on the previous active version (ADR-043 §5)', () => {
  /** v3 outstanding, over a v2 the resource stepped off. */
  async function outstandingV3() {
    await db
      .update(resourceVersion)
      .set({ state: 'superseded' })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 2)))
    await db.insert(resourceVersion).values({
      resourceId,
      version: 3,
      storageKey: getStorageKey(packageId, resourceId, 'v3'),
      size: 103,
      hash: 'sha256:v3',
      origin: 'upload',
      state: 'active',
      format: 'csv',
    })
    vi.mocked(ingestParquetVersion).mockResolvedValue({ snapshotId: 20 })
  }

  const ingestV3 = () =>
    withLakeIngestLock(db, (tx) =>
      ingestVersionIntoLake(tx, {} as LakeSession, {
        resourceId,
        version: 3,
        sourcePath: '/tmp/v3.parquet',
      })
    )

  it('stands the table back on the base when a revert left it ahead', async () => {
    // v2 reached the lake and was then stepped off; its reconcile never ran, so
    // the table still holds v2's rows. ii-a would write over them either way —
    // but the shape check it makes on the way, and ii-b's MERGE, read them.
    await outstandingV3()

    await ingestV3()

    expect(rollbackLakeTable).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(String),
      5
    )
    expect(await snapshotOf(1)).toBe(LANDED)
    expect(ingestParquetVersion).toHaveBeenCalledOnce()
  })

  it('moves nothing when the table already stands on the base', async () => {
    await outstandingV3()
    // The reconcile ran: v1 carries where the rollback landed, above every
    // stepped-off version's.
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: LANDED })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))

    await ingestV3()

    expect(rollbackLakeTable).not.toHaveBeenCalled()
    expect(ingestParquetVersion).toHaveBeenCalledOnce()
  })

  it('moves nothing when no active version below reached the lake', async () => {
    // Nothing to build on: whatever the table holds, the ingest replaces it
    // wholesale and there is no base to rebase onto.
    await outstandingV3()
    await db
      .update(resourceVersion)
      .set({ ducklakeSnapshotId: null })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))

    await ingestV3()

    expect(rollbackLakeTable).not.toHaveBeenCalled()
    expect(ingestParquetVersion).toHaveBeenCalledOnce()
  })
})
