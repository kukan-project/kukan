/**
 * Dropping the shared lake catalog (ADR-067 §6): refused while a resource is
 * still to be moved off it, and then nothing of it left — its schema, and its
 * files outside any resource's prefix — while every resource's own stays.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { lakeResourcePrefix } from '@kukan/lake'
import { getStorageKey } from '@kukan/shared'
import {
  dropSharedLakeCatalog,
  inspectSharedLakeCatalog,
} from '../../../services/lake/shared-lake-catalog'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()

let objects: Set<string>
const storage = {
  list: async (prefix: string) => ({
    objects: [...objects]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, lastModified: new Date() })),
  }),
  deleteMany: async (keys: string[]) => {
    for (const key of keys) objects.delete(key)
    return keys
  },
}

const SHARED_FILE = 'lake/main/res_0a/ducklake-0001.parquet'
let resourceId: string
let packageId: string

async function addVersion(version: number, extra: Partial<typeof resourceVersion.$inferInsert>) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    format: 'CSV',
    ...extra,
  })
}

async function schemaExists() {
  const rows = await db.execute(sql`SELECT 1 FROM pg_namespace WHERE nspname = 'ducklake'`)
  return rows.rows.length > 0
}

beforeEach(async () => {
  await cleanDatabase()
  await db.execute(sql`DROP SCHEMA IF EXISTS ducklake CASCADE`)
  await db.execute(sql`CREATE SCHEMA ducklake`)
  await db.execute(sql`CREATE TABLE ducklake.ducklake_snapshot (snapshot_id BIGINT)`)
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-shared-lake', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
  objects = new Set([SHARED_FILE, `${lakeResourcePrefix(resourceId)}g/catalog.c.sqlite`])
})

afterAll(async () => {
  await db.execute(sql`DROP SCHEMA IF EXISTS ducklake CASCADE`)
  await closeTestDb()
})

describe('dropSharedLakeCatalog', () => {
  it('refuses while a resource is still to be moved off it, deleting nothing', async () => {
    await addVersion(1, { ducklakeSnapshotId: 40 })

    expect(await inspectSharedLakeCatalog(db, storage)).toEqual({
      unmigrated: 1,
      schema: true,
      files: [SHARED_FILE],
    })
    await expect(dropSharedLakeCatalog(db, storage)).rejects.toThrow('still to be moved')
    expect(objects.has(SHARED_FILE)).toBe(true)
    expect(await schemaExists()).toBe(true)
  })

  it("drops its schema and files once every resource is moved, and keeps each resource's own", async () => {
    await addVersion(1, { ducklakeSnapshotId: 40, lakeSnapshotId: 1 })
    // Not to be moved: purged, or refused a load already
    await addVersion(2, { ducklakeSnapshotId: 41, state: 'purged' })
    await addVersion(3, { ducklakeSnapshotId: 42, lakeIngestReason: 'ingest-failed' })

    await dropSharedLakeCatalog(db, storage)

    expect(await schemaExists()).toBe(false)
    expect([...objects]).toEqual([`${lakeResourcePrefix(resourceId)}g/catalog.c.sqlite`])
    expect(await inspectSharedLakeCatalog(db, storage)).toEqual({
      unmigrated: 0,
      schema: false,
      files: [],
    })
  })

  it('does not wait on a deleted resource, which the sweep does not move', async () => {
    await addVersion(1, { ducklakeSnapshotId: 40 })
    await db.update(resource).set({ state: 'deleted' })

    expect((await inspectSharedLakeCatalog(db, storage)).unmigrated).toBe(0)
  })
})
