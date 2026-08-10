/**
 * Integration tests for VersionDiffService (ADR-043 layer 2 / Phase ii-a).
 *
 * Covers the resolution logic that runs before DuckLake is touched: picking the
 * comparison version, and the cases that are reported as unavailable rather than
 * queried. A lake config is supplied but must never be used here — every case
 * below returns before a session is opened, so these run without MinIO.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { VersionDiffService } from '../../services/version-diff-service'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const service = new VersionDiffService(db, unreachableLake)

let packageId: string
let resourceId: string

async function addVersion(
  version: number,
  opts: { state?: string; snapshotId?: number | null } = {}
) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 100 + version,
    hash: `sha256:v${version}`,
    origin: 'upload',
    state: opts.state ?? 'active',
    ducklakeSnapshotId: opts.snapshotId ?? null,
  })
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-diff', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const res = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload', hash: 'sha256:v2', size: 102 })
    .returning()
  resourceId = res[0].id
})

afterAll(async () => {
  await closeTestDb()
})

describe('VersionDiffService.diff', () => {
  it('reports the first version as having nothing to compare against', async () => {
    await addVersion(1, { snapshotId: 10 })

    const result = await service.diff(resourceId, 1)

    expect(result).toEqual({
      available: false,
      reason: 'no-previous-version',
      from: null,
      to: 1,
    })
  })

  it('reports versions that were never ingested into the lake', async () => {
    await addVersion(1)
    await addVersion(2)

    const result = await service.diff(resourceId, 2)

    expect(result).toMatchObject({ available: false, reason: 'not-ingested', from: 1, to: 2 })
  })

  it('reports not-ingested when only one side has a snapshot', async () => {
    await addVersion(1)
    await addVersion(2, { snapshotId: 20 })

    const result = await service.diff(resourceId, 2)

    expect(result).toMatchObject({ available: false, reason: 'not-ingested' })
  })

  it('reports purged versions rather than comparing them', async () => {
    await addVersion(1, { state: 'purged', snapshotId: 10 })
    await addVersion(2, { snapshotId: 20 })

    const result = await service.diff(resourceId, 2)

    expect(result).toMatchObject({ available: false, reason: 'purged', from: 1, to: 2 })
  })

  it('defaults to the immediately preceding version, skipping gaps', async () => {
    // v2 was purged and hard-deleted at some point, leaving a gap in numbering.
    await addVersion(1)
    await addVersion(5)

    const result = await service.diff(resourceId, 5)

    expect(result).toMatchObject({ from: 1, to: 5 })
  })

  it('honours an explicit from version', async () => {
    await addVersion(1)
    await addVersion(2)
    await addVersion(3)

    const result = await service.diff(resourceId, 3, 1)

    expect(result).toMatchObject({ from: 1, to: 3 })
  })

  it('throws when the requested version does not exist', async () => {
    await addVersion(1)

    await expect(service.diff(resourceId, 99)).rejects.toThrow(/not found/i)
  })

  it('throws when an explicit from version does not exist', async () => {
    await addVersion(1)
    await addVersion(2)

    await expect(service.diff(resourceId, 2, 99)).rejects.toThrow(/not found/i)
  })
})
