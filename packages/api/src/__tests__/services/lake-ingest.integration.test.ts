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
import type { LakeSession } from '@kukan/lake'
import { getStorageKey } from '@kukan/shared'
import { ingestVersionIntoLake } from '../../services/lake-ingest'
import { reclaimLakeStorage } from '../../services/lake-reclaim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let packageId: string
let resourceId: string

/**
 * Answers just enough for the create-table path: no table yet, then a snapshot
 * id. Everything else about DuckLake is exercised in `@kukan/lake`.
 */
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

async function addVersion(
  version: number,
  snapshotId: number | null,
  lakeKeyColumns: string[] | null = null
) {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getStorageKey(packageId, resourceId, `v${version}`),
    size: 10,
    hash: `sha256:v${version}`,
    origin: 'upload',
    ducklakeSnapshotId: snapshotId,
    lakeKeyColumns,
  })
}

/**
 * A session that answers what a keyed ingest asks of the source — its columns
 * and how its key behaves over the rows — and remembers the statements it was
 * asked to run, which is how the branch it took is read back.
 */
function stubSession(
  source: {
    columns?: string[]
    rows?: number
    distinct?: number
    nulls?: number
    /** Whether the table is already there, which decides the load's first branch. */
    exists?: boolean
  } = {}
) {
  const ran: string[] = []
  const session = {
    run: async (sql: string) => void ran.push(sql),
    rows: async (sql: string) => {
      if (sql.includes('ducklake_snapshots')) return [{ id: 99 }]
      if (sql.includes('duckdb_tables()')) return source.exists === false ? [] : [{ exists: 1 }]
      if (sql.startsWith('DESCRIBE')) {
        return (source.columns ?? []).map((name) => ({ column_name: name, column_type: 'VARCHAR' }))
      }
      return [
        {
          rows: source.rows ?? 2,
          nulls: source.nulls ?? 0,
          distinct_keys: source.distinct ?? source.rows ?? 2,
        },
      ]
    },
    interrupt: () => {},
    close: async () => {},
  } as unknown as LakeSession
  return { session, ran }
}

const reasonOf = async (version: number) =>
  (
    await db
      .select({ reason: resourceVersion.lakeIngestReason })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
  )[0]?.reason ?? null

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-lake-ingest', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
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
      ingestVersionIntoLake(tx, refusingSession, {
        resourceId,
        version: 2,
        sourcePath: '/tmp/v2.parquet',
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
      ingestVersionIntoLake(tx, refusingSession, {
        resourceId,
        version: 1,
        sourcePath: '/tmp/v1.parquet',
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
        ingestVersionIntoLake(tx, refusingSession, {
          resourceId,
          version: 2,
          sourcePath: '/tmp/v2.parquet',
        })
      )
    ).rejects.toThrow('reached DuckLake')
  })

  it('applies a keyed version by MERGE when the base carries the same key', async () => {
    // The version's rows are matched against contents identified the same way,
    // which is the whole of what ii-b buys (spec §11-2.4).
    await addVersion(1, 7, ['id'])
    await addVersion(2, null, ['id'])
    const { session, ran } = stubSession({ columns: ['id', 'name'] })

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, session, {
        resourceId,
        version: 2,
        sourcePath: '/tmp/v2.parquet',
      })
    )

    expect(ran.some((sql) => sql.startsWith('MERGE INTO'))).toBe(true)
    expect(await reasonOf(2)).toBeNull()
  })

  it('reads what the table holds, including a version already claimed for purge', async () => {
    // A purge takes its version out of the active set the moment it is claimed
    // and steps the table down later, in a worker. In between the rows are
    // still that version's — and they are identified by *its* key, so merging
    // onto them under another would match rows the uniqueness check never saw
    // (spec §6.6).
    await addVersion(1, 5, ['id'])
    await addVersion(2, 9, ['other'])
    await db
      .update(resourceVersion)
      .set({ state: 'purging' })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 2)))
    await addVersion(3, null, ['id'])
    const { session, ran } = stubSession({ columns: ['id', 'name'] })

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, session, {
        resourceId,
        version: 3,
        sourcePath: '/tmp/v3.parquet',
      })
    )

    // v1 shares this version's key, but v1's rows are not what the table holds.
    expect(ran.some((sql) => sql.startsWith('MERGE INTO'))).toBe(false)
    expect(ran.some((sql) => sql.startsWith('DELETE FROM'))).toBe(true)
  })

  it('will not merge onto a head whose purge has already moved the contents', async () => {
    // The step-down commits in DuckLake before the purge nulls the id (spec §9.1
    // steps 4 and 6). Fail in between — the reclaim, the object delete — and the
    // claim is released with the row still naming a snapshot the table has
    // stepped off. Its key then describes contents that are no longer there, and
    // the rows actually in the table were never checked for that key.
    await addVersion(1, 5, ['other'])
    await addVersion(2, 9, ['id'])
    await db
      .update(resourceVersion)
      .set({ state: 'purging' })
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 2)))
    await addVersion(3, null, ['id'])
    const { session, ran } = stubSession({ columns: ['id', 'name'] })

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, session, {
        resourceId,
        version: 3,
        sourcePath: '/tmp/v3.parquet',
      })
    )

    expect(ran.some((sql) => sql.startsWith('MERGE INTO'))).toBe(false)
    expect(ran.some((sql) => sql.startsWith('DELETE FROM'))).toBe(true)
  })

  it('replaces the contents when the base was loaded under another key', async () => {
    // The incoming key's uniqueness says nothing about contents identified
    // another way, and `MERGE` resolves a duplicate by dropping a row (§6.6).
    await addVersion(1, 7, ['other'])
    await addVersion(2, null, ['id'])
    const { session, ran } = stubSession({ columns: ['id', 'name'] })

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, session, {
        resourceId,
        version: 2,
        sourcePath: '/tmp/v2.parquet',
      })
    )

    expect(ran.some((sql) => sql.startsWith('MERGE INTO'))).toBe(false)
    expect(ran.some((sql) => sql.startsWith('DELETE FROM'))).toBe(true)
  })

  it('records why a key was refused, and writes nothing', async () => {
    // The version stays out of layer 2 and out of the sweep, which would
    // otherwise hand it back every hour to be turned away again (spec §6.6).
    await addVersion(1, null, ['id'])
    const { session, ran } = stubSession({ columns: ['id'], rows: 2, distinct: 1 })

    const result = await db.transaction((tx) =>
      ingestVersionIntoLake(tx, session, {
        resourceId,
        version: 1,
        sourcePath: '/tmp/v1.parquet',
      })
    )

    expect(result).toBeNull()
    expect(await reasonOf(1)).toBe('key-not-unique')
    expect(ran).toEqual([])
    const [row] = await db
      .select({ snapshot: resourceVersion.ducklakeSnapshotId })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.snapshot).toBeNull()
  })

  it('records the snapshot on the version once it is in', async () => {
    await addVersion(1, null)

    await db.transaction((tx) =>
      ingestVersionIntoLake(tx, stubSession({ exists: false }).session, {
        resourceId,
        version: 1,
        sourcePath: '/tmp/v1.parquet',
      })
    )

    const [row] = await db
      .select({ snapshot: resourceVersion.ducklakeSnapshotId })
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row).toEqual({ snapshot: 99 })
  })
})

describe('reclaimLakeStorage', () => {
  it('does nothing without a lake configured', async () => {
    // Deployments run without layer 2, and every purge path now calls this.
    expect(await reclaimLakeStorage(db, undefined)).toEqual({ expired: 0, filesDeleted: 0 })
  })
})
