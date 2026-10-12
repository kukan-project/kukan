/**
 * What a purge is told to erase: every resource of the packages, which the
 * purge claims and whose layer 2 it deletes by prefix (ADR-067). Every one,
 * not only those a catalog holds — a resource whose first load failed can have
 * files there and no catalog.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { packageTable, resource } from '@kukan/db'
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

describe('listPurgeTargets', () => {
  it('asks nothing of the database when there are no packages', async () => {
    const { db: recorder, queries } = createQueryRecorder()

    expect(await listPurgeTargets(recorder, [])).toEqual({ resourceIds: [] })
    expect(queries).toEqual([])
  })

  it('names every resource of the package', async () => {
    const a = await addResource('a')
    const b = await addResource('b')

    const { resourceIds } = await listPurgeTargets(db, [packageId])
    expect([...resourceIds].sort()).toEqual([a, b].sort())
  })

  it('ignores resources of other packages', async () => {
    const mine = await addResource('mine')
    const other = await addPackage('other-pkg')
    await addResource('theirs', other)

    expect(await listPurgeTargets(db, [packageId])).toEqual({ resourceIds: [mine] })
  })
})
