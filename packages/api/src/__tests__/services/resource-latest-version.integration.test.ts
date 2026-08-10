/**
 * Integration test: listByPackage surfaces latestVersion (ADR-043).
 * Guards the version-aggregate join against regressions (a correlated
 * subquery silently returned null in an earlier attempt).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { ResourceService } from '../../services/resource-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceService(db)

let packageId: string

async function addResource(name: string): Promise<string> {
  const [r] = await db.insert(resource).values({ packageId, name }).returning()
  return r.id
}

async function addVersion(resourceId: string, version: number, state = 'active') {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    hash: `sha256:v${version}`,
    origin: 'upload',
    state,
  })
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-latest-ver', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('listByPackage latestVersion', () => {
  it('returns the max non-purged version, null when unversioned', async () => {
    const withVersions = await addResource('has-versions')
    const unversioned = await addResource('no-versions')
    await addVersion(withVersions, 1)
    await addVersion(withVersions, 2)

    const rows = await service.listByPackage(packageId)
    const byId = new Map(rows.map((r) => [r.id, r]))

    expect(byId.get(withVersions)?.latestVersion).toBe(2)
    expect(byId.get(unversioned)?.latestVersion).toBeNull()
  })

  it('ignores purged tombstones when computing the latest version', async () => {
    const r = await addResource('rolled-back')
    await addVersion(r, 1)
    await addVersion(r, 2, 'purged') // purged latest → live is v1

    const rows = await service.listByPackage(packageId)
    expect(rows.find((x) => x.id === r)?.latestVersion).toBe(1)
  })
})
