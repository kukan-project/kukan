/**
 * Integration tests for the DuckLake ingest preconditions (ADR-043 layer 2).
 *
 * The invariant under test: the lake's current contents are the resource's
 * current contents. Phase ii-a ingests whole versions, so loading one replaces
 * the table — an ingest that runs out of order rewinds it.
 *
 * No DuckLake here: both cases refuse before reaching it, which the session
 * stub asserts by throwing if it is ever used.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeSession } from '@kukan/lake'
import { ingestVersionIntoLake } from '../../services/lake-ingest'
import { reclaimLakeStorage } from '../../services/lake-reclaim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let resourceId: string

/** Fails the test if the ingest gets as far as touching DuckLake. */
const refusingSession = {
  run: () => {
    throw new Error('reached DuckLake')
  },
  rows: () => {
    throw new Error('reached DuckLake')
  },
  interrupt: () => {},
  close: async () => {},
} as unknown as LakeSession

const lake = { bucket: 'b', region: 'r', pgConnString: '', s3UseSsl: false } as LakeConfig

async function addVersion(version: number, snapshotId: number | null) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: `versions/${resourceId}/v${version}`,
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    ducklakeSnapshotId: snapshotId,
  })
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-lake-ingest', 'active') RETURNING id
  `)
  const packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
})

afterAll(async () => {
  await closeTestDb()
})

describe('ingestVersionIntoLake', () => {
  it('refuses a version a newer one has already overtaken', async () => {
    // A retry that waited while the next version went in. Loading v2 now would
    // leave the lake serving content the resource no longer has, under a
    // snapshot id above v3's.
    await addVersion(2, null)
    await addVersion(3, 99)

    const result = await db.transaction((tx) =>
      ingestVersionIntoLake(tx, refusingSession, lake, {
        resourceId,
        version: 2,
        previewKey: 'previews/v2.parquet',
      })
    )

    expect(result).toBeNull()
    // Refusing must not look like success: the version stays un-ingested so a
    // rebuild from layer 1 can still pick it up.
    const [row] = await db
      .select({ snapshot: resourceVersion.ducklakeSnapshotId })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 2)))
    expect(row.snapshot).toBeNull()
  })

  it('refuses a version that is already in', async () => {
    // ii-a ingests whole versions, so a second pass would append every row
    // again. The retry path exists to run after something else may have won.
    await addVersion(1, 42)

    const result = await db.transaction((tx) =>
      ingestVersionIntoLake(tx, refusingSession, lake, {
        resourceId,
        version: 1,
        previewKey: 'previews/v1.parquet',
      })
    )

    expect(result).toBeNull()
  })

  it('does not count an older version as an overtake', async () => {
    // v1 being in is the normal case for ingesting v2, not a reason to refuse.
    await addVersion(1, 42)
    await addVersion(2, null)

    await expect(
      db.transaction((tx) =>
        ingestVersionIntoLake(tx, refusingSession, lake, {
          resourceId,
          version: 2,
          previewKey: 'previews/v2.parquet',
        })
      )
    ).rejects.toThrow('reached DuckLake')
  })
})

describe('reclaimLakeStorage', () => {
  it('does nothing without a lake configured', async () => {
    // Deployments run without layer 2, and every purge path now calls this.
    expect(await reclaimLakeStorage(db, undefined)).toEqual({ expired: 0, filesDeleted: 0 })
  })
})
