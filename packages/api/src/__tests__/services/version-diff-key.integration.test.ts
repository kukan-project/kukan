/**
 * Which comparison a diff request gets (spec §7), against real PostgreSQL with
 * the DuckLake call stubbed.
 *
 * **The decision this file covers is the one `packages/lake` cannot see.** It
 * receives the key already resolved, so a wrong resolution there looks like a
 * perfectly good keyed diff — of two versions whose rows were never identified
 * the same way, which is a count belonging to neither rule.
 *
 * A file of its own because the module mock is hoisted over the whole file, and
 * its neighbour proves the opposite thing: that those cases never reach a lake
 * session at all.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { diffVersions, openLakeSession } from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { VersionDiffService } from '../../services/version-diff-service'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return {
    ...actual,
    openLakeSession: vi.fn(),
    diffVersions: vi.fn(),
  }
})

const db = getTestDb()
const service = new VersionDiffService(db, unreachableLake)

let packageId: string
let resourceId: string

async function addVersion(version: number, snapshotId: number, keyColumns: string[] | null) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 100 + version,
    hash: `sha256:v${version}`,
    origin: 'upload',
    ducklakeSnapshotId: snapshotId,
    lakeKeyColumns: keyColumns,
  })
}

/** What the lake was asked to compare the two snapshots by. */
const askedKey = () => vi.mocked(diffVersions).mock.calls[0][1].key

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-diff-key', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id

  vi.clearAllMocks()
  vi.mocked(openLakeSession).mockResolvedValue({
    run: async () => {},
    rows: async () => [],
    interrupt: () => {},
    close: async () => {},
  } as unknown as LakeSession)
  vi.mocked(diffVersions).mockResolvedValue({
    schemaChanged: false,
    keyed: false,
    addedRows: 0,
    removedRows: 0,
    sampleAdded: [],
    sampleRemoved: [],
  })
})

afterAll(async () => {
  await closeTestDb()
  vi.restoreAllMocks()
})

describe('which comparison a diff gets', () => {
  it('matches rows by the key when both ends were loaded under it', async () => {
    await addVersion(1, 5, ['order', 'line'])
    await addVersion(2, 9, ['order', 'line'])

    await service.diff(resourceId, 2)

    expect(askedKey()).toEqual(['order', 'line'])
  })

  it('compares whole rows across a key change', async () => {
    // Rows matched under one identification and counted against rows identified
    // by another give a number belonging to neither (spec §7), so the boundary
    // degrades rather than being reached over.
    await addVersion(1, 5, ['order'])
    await addVersion(2, 9, ['order', 'line'])

    await service.diff(resourceId, 2)

    expect(askedKey()).toBeNull()
  })

  it('compares whole rows when only one end has a key', async () => {
    await addVersion(1, 5, null)
    await addVersion(2, 9, ['id'])

    await service.diff(resourceId, 2)

    expect(askedKey()).toBeNull()
  })

  it('compares whole rows when neither end has one', async () => {
    await addVersion(1, 5, null)
    await addVersion(2, 9, null)

    await service.diff(resourceId, 2)

    expect(askedKey()).toBeNull()
  })

  it('reads the key of the version named, not of the newest', async () => {
    // An explicit `from` compares two versions that need not be adjacent, and
    // the key question is about those two.
    await addVersion(1, 5, ['id'])
    await addVersion(2, 9, ['other'])
    await addVersion(3, 11, ['id'])

    await service.diff(resourceId, 3, 1)

    expect(askedKey()).toEqual(['id'])
  })
})
