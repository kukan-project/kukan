/**
 * Dropping the shared lake catalog (ADR-067 §6): nothing of it left — its schema, and its
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

async function addVersion(version: number) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    format: 'CSV',
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
  it("drops its schema and files, and keeps each resource's own", async () => {
    // Not waited on: the move off it reads layer 1 only
    await addVersion(1)
    expect(await inspectSharedLakeCatalog(db, storage)).toEqual({
      schema: true,
      files: [SHARED_FILE],
    })

    await dropSharedLakeCatalog(db, storage)

    expect(await schemaExists()).toBe(false)
    expect([...objects]).toEqual([`${lakeResourcePrefix(resourceId)}g/catalog.c.sqlite`])
    expect(await inspectSharedLakeCatalog(db, storage)).toEqual({
      schema: false,
      files: [],
    })
  })
})
