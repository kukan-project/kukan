/**
 * What a purge is told to erase.
 *
 * `lakeResourceIds` is the half with no other witness: the caller pairs it with
 * `dropResourceTables`, so a resource missing from it keeps its DuckLake table
 * after the package is gone (ADR-043 layer 2). An empty list is also what a
 * package with nothing in the lake looks like, which is why every case here
 * puts resources on both sides of the question.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { packageTable, resource, resourceVersion } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { listPurgeTargets } from '../../services/package-cleanup'
import { getTestDb, createQueryRecorder, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let packageId: string

beforeEach(async () => {
  await cleanDatabase()
  packageId = await addPackage('purge-targets-pkg')
})

afterAll(async () => {
  await closeTestDb()
})

async function addPackage(name: string): Promise<string> {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name, state: 'active' })
    .returning({ id: packageTable.id })
  return pkg.id
}

async function addResource(name: string, pkg = packageId): Promise<string> {
  const [r] = await db
    .insert(resource)
    .values({ packageId: pkg, name, state: 'active' })
    .returning({ id: resource.id })
  return r.id
}

/** A version of that resource, in the lake or not depending on the snapshot id. */
async function addVersion(
  resourceId: string,
  version: number,
  snapshotId: number | null,
  pkg = packageId
) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(pkg, resourceId, `v${version}`),
    size: 1,
    hash: `sha256:v${version}`,
    origin: 'upload',
    ducklakeSnapshotId: snapshotId,
  })
}

describe('listPurgeTargets', () => {
  it('asks nothing of the database when there are no packages', async () => {
    const { db: recorder, queries } = createQueryRecorder()

    expect(await listPurgeTargets(recorder, [])).toEqual({ resourceIds: [], lakeResourceIds: [] })
    expect(queries).toEqual([])
  })

  it('names every resource of the package', async () => {
    const a = await addResource('a')
    const b = await addResource('b')

    const { resourceIds } = await listPurgeTargets(db, [packageId])
    expect([...resourceIds].sort()).toEqual([a, b].sort())
  })

  it('names only the resources whose content reached the lake', async () => {
    const inLake = await addResource('in-lake')
    const versionedOnly = await addResource('versioned-only')
    await addResource('no-versions')

    await addVersion(inLake, 1, 42)
    await addVersion(versionedOnly, 1, null)

    const { lakeResourceIds } = await listPurgeTargets(db, [packageId])
    expect(lakeResourceIds).toEqual([inLake])
  })

  it('names a resource whose lake snapshot is on a later version', async () => {
    // Per version, not per resource: v1 predates the lake and v2 reached it,
    // and the resource still owns a table to drop.
    const mixed = await addResource('mixed')
    await addVersion(mixed, 1, null)
    await addVersion(mixed, 2, 13)

    const { lakeResourceIds } = await listPurgeTargets(db, [packageId])
    expect(lakeResourceIds).toEqual([mixed])
  })

  it('ignores resources of other packages', async () => {
    const mine = await addResource('mine')
    await addVersion(mine, 1, 1)

    const other = await addPackage('other-pkg')
    const theirs = await addResource('theirs', other)
    await addVersion(theirs, 1, 99, other)

    const { resourceIds, lakeResourceIds } = await listPurgeTargets(db, [packageId])
    expect(resourceIds).toEqual([mine])
    expect(lakeResourceIds).toEqual([mine])
  })
})
