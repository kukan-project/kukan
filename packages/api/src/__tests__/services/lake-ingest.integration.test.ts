/**
 * Integration tests for the DuckLake ingest preconditions (ADR-043 layer 2).
 *
 * The invariant under test: the lake's current contents are the resource's
 * current contents. Phase ii-a ingests whole versions, so loading one replaces
 * the table — an ingest that runs out of order rewinds it.
 *
 * No real DuckLake here: the refusal cases never reach it, which a session stub
 * asserts by throwing if it is ever used, and the one case that gets past them
 * runs against a stub that answers the two queries an ingest asks.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import type { LakeConfig, LakeSession } from '@kukan/lake'
import { ingestVersionIntoLake, releaseLakeSource } from '../../services/lake-ingest'
import { reclaimLakeStorage } from '../../services/lake-reclaim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let resourceId: string

/**
 * Answers just enough for the create-table path: no table yet, then a snapshot
 * id. Everything else about DuckLake is exercised in `@kukan/lake`.
 */
const ingestingSession = {
  run: async () => {},
  rows: async (sql: string) =>
    sql.includes('ducklake_snapshots') ? [{ id: 99 }] : ([] as unknown[]),
  interrupt: () => {},
  close: async () => {},
} as unknown as LakeSession

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

async function addVersion(version: number, snapshotId: number | null, lakeSourceKey?: string) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: `versions/${resourceId}/v${version}`,
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    ducklakeSnapshotId: snapshotId,
    lakeSourceKey: lakeSourceKey ?? null,
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

  it('lets go of the Parquet when a newer version has already been ingested', async () => {
    // Refused for good — no later pass changes the answer. Left set, the
    // pointer keeps this version in the pending count and pins its Parquet by a
    // reference nothing will ever release (ADR-043 §6-6).
    await addVersion(1, null, 'previews/v1.parquet')
    await addVersion(2, 42)

    const result = await db.transaction((tx) =>
      ingestVersionIntoLake(tx, refusingSession, lake, {
        resourceId,
        version: 1,
        previewKey: 'previews/v1.parquet',
      })
    )

    expect(result).toBeNull()
    const [row] = await db
      .select({ source: resourceVersion.lakeSourceKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.source).toBeNull()
    const parked = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect((parked.rows as unknown as { key: string }[]).map((r) => r.key)).toEqual([
      'previews/v1.parquet',
    ])
  })

  it('lets go of the Parquet it was waiting on once the version is in', async () => {
    // The pointer is what keeps that preview from being swept (ADR-043 §6-6).
    // Left behind, it would pin the object for as long as the version lives.
    await addVersion(1, null, 'previews/v1.parquet')

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, ingestingSession, lake, {
        resourceId,
        version: 1,
        previewKey: 'previews/v1.parquet',
      })
    )

    const [row] = await db
      .select({
        snapshot: resourceVersion.ducklakeSnapshotId,
        source: resourceVersion.lakeSourceKey,
      })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row).toEqual({ snapshot: 99, source: null })
  })

  it('leaves a pointer another attempt has moved on', async () => {
    // Read the pointer, decided to give up, and got here after another attempt
    // recorded a different Parquet. Withdrawing that one's intent would strand
    // the version it belongs to.
    await addVersion(1, null, 'previews/second-attempt.parquet')

    const released = await releaseLakeSource(db, {
      resourceId,
      version: 1,
      previewKey: 'previews/first-attempt.parquet',
    })

    expect(released).toBe(false)
    const [row] = await db
      .select({ source: resourceVersion.lakeSourceKey })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.source).toBe('previews/second-attempt.parquet')
    expect((await db.execute(sql`SELECT key FROM orphaned_object`)).rows).toEqual([])
  })

  it('parks the Parquet it lets go of', async () => {
    // While the version named it, the sweep read the key as referenced and
    // dropped its ledger record (ADR-045 §3). Clearing the pointer without
    // parking it again would leave an object with neither — the one state that
    // ledger exists to prevent.
    await addVersion(1, null, 'previews/v1.parquet')

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, ingestingSession, lake, {
        resourceId,
        version: 1,
        previewKey: 'previews/v1.parquet',
      })
    )

    const parked = await db.execute(sql`SELECT key FROM orphaned_object`)
    expect((parked.rows as unknown as { key: string }[]).map((r) => r.key)).toEqual([
      'previews/v1.parquet',
    ])
  })
})

describe('reclaimLakeStorage', () => {
  it('does nothing without a lake configured', async () => {
    // Deployments run without layer 2, and every purge path now calls this.
    expect(await reclaimLakeStorage(db, undefined)).toEqual({ expired: 0, filesDeleted: 0 })
  })
})
