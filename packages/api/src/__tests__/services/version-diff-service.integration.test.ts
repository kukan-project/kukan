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
import type { VersionState } from '@kukan/shared'
import { VersionDiffService } from '../../services/version-diff-service'
import { unreachableLake } from '../test-helpers/fixtures'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const service = new VersionDiffService(db, unreachableLake)

let packageId: string
let resourceId: string

async function addVersion(
  version: number,
  opts: {
    state?: VersionState
    snapshotId?: number | null
    ingestReason?: 'key-missing' | 'key-null' | 'key-not-unique'
  } = {}
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
    lakeIngestReason: opts.ingestReason ?? null,
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
      reasonVersion: null,
    })
  })

  it('reports versions that were never ingested into the lake', async () => {
    await addVersion(1)
    await addVersion(2)

    const result = await service.diff(resourceId, 2)

    expect(result).toMatchObject({ available: false, reason: 'not-ingested', from: 1, to: 2 })
  })

  it('reports not-ingested against the side that has no snapshot', async () => {
    // The opened version loaded fine; it is its predecessor that is not
    // covered. Unnamed, the sentence reads as a verdict on v2.
    await addVersion(1)
    await addVersion(2, { snapshotId: 20 })

    expect(await service.diff(resourceId, 2)).toMatchObject({
      available: false,
      reason: 'not-ingested',
      reasonVersion: 1,
    })
  })

  it('names the key fault rather than calling a refused version not ingested', async () => {
    // `not-ingested` says "not tabular, or from before the feature" — both false
    // here, and the difference matters: this is the one cause the operator can
    // fix (spec §6.6). The reason is recorded on the version and nothing else
    // shows it, so without this the screen states a cause that is not the one.
    await addVersion(1, { snapshotId: 10 })
    await addVersion(2, { ingestReason: 'key-not-unique' })

    expect(await service.diff(resourceId, 2)).toMatchObject({
      available: false,
      reason: 'key-not-unique',
      from: 1,
      to: 2,
      reasonVersion: 2,
    })
  })

  it("names the predecessor when the fault is the predecessor's", async () => {
    // The repair path, and the reason `reasonVersion` exists: the key was
    // corrected, v2 took the correction and loaded, and the reader opens v2's
    // diff — whose other end is the version that was refused. An answer that
    // did not name v1 reads as a verdict on v2 and undoes a fix that worked.
    await addVersion(1, { ingestReason: 'key-null' })
    await addVersion(2, { snapshotId: 20 })

    expect(await service.diff(resourceId, 2)).toMatchObject({
      reason: 'key-null',
      reasonVersion: 1,
    })
  })

  it('answers with the end that was asked about when both were refused', async () => {
    await addVersion(1, { ingestReason: 'key-null' })
    await addVersion(2, { ingestReason: 'key-missing' })

    expect(await service.diff(resourceId, 2)).toMatchObject({
      reason: 'key-missing',
      reasonVersion: 2,
    })
  })

  it('names this end when neither was ingested', async () => {
    await addVersion(1)
    await addVersion(2)

    expect(await service.diff(resourceId, 2)).toMatchObject({
      reason: 'not-ingested',
      reasonVersion: 2,
    })
  })

  it('prefers a recorded refusal to the plain absence of a snapshot', async () => {
    // Both ends are missing from layer 2, but only one of them says why, and
    // that one is the only thing an operator can act on (spec §6.6).
    await addVersion(1, { ingestReason: 'key-not-unique' })
    await addVersion(2)

    expect(await service.diff(resourceId, 2)).toMatchObject({
      reason: 'key-not-unique',
      reasonVersion: 1,
    })
  })

  it('names no version where no single version is the subject', async () => {
    await addVersion(1, { snapshotId: 10 })

    expect(await service.diff(resourceId, 1)).toMatchObject({
      reason: 'no-previous-version',
      reasonVersion: null,
    })
  })

  it('says only that a version is purged, never why its key failed', async () => {
    // The reason is a statement about content the tombstone no longer holds —
    // that a key column was null, that the key repeated (spec §9.4). The purge
    // branch is ahead of the refusal branch so it cannot be reached for one.
    await addVersion(1, { snapshotId: 10 })
    await addVersion(2, { state: 'purged', ingestReason: 'key-null' })

    expect(await service.diff(resourceId, 2)).toMatchObject({ reason: 'purged' })
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
