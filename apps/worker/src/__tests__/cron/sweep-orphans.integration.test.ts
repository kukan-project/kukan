/**
 * Integration tests for the orphan sweep's reference check (ADR-045 §3).
 *
 * The unit tests around this sweep stub `execute`, so the one statement that
 * decides what gets deleted is never run. It has to be: a pointer source
 * missing from it is an object deleted out from under the row that names it,
 * and no mock can tell you whether the SQL asks about all of them.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { Logger } from '@kukan/shared'
import { sweepOrphanedObjects } from '../../cron/orphan-cleanup/sweep-orphans'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const log = { info: vi.fn() } as unknown as Logger

/** Deletes everything it is given, and remembers what that was. */
function fakeStorage() {
  const deleted: string[] = []
  const storage = {
    deleteMany: async (keys: string[]) => {
      deleted.push(...keys)
      return keys
    },
  } as unknown as StorageAdapter
  return { storage, deleted }
}

let packageId: string
let resourceId: string

/** A key the sweep is free to consider: parked, and past its expiry. */
async function due(key: string) {
  await db.execute(sql`
    INSERT INTO orphaned_object (key, expires_at) VALUES (${key}, NOW() - INTERVAL '1 minute')
  `)
}

async function tracked(): Promise<string[]> {
  const rows = await db.execute(sql`SELECT key FROM orphaned_object ORDER BY key`)
  return (rows.rows as unknown as { key: string }[]).map((r) => r.key)
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-sweep', 'active') RETURNING id
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

describe('sweepOrphanedObjects', () => {
  it('leaves alone a key any pointer still names, and stops tracking it', async () => {
    // One per source the check reads. A source it does not ask about is a live
    // object this sweep deletes, so they are asserted together rather than one
    // test each: the list is the invariant, not any single entry.
    const live = {
      storageKey: 'live/current',
      pendingStorageKey: 'live/pending',
      versionKey: 'live/version',
      lakeSourceKey: 'live/lake-source',
      previewKey: 'live/preview',
      textHeadKey: 'live/text-head',
    }
    await db.execute(sql`
      UPDATE resource SET storage_key = ${live.storageKey},
                          pending_storage_key = ${live.pendingStorageKey}
      WHERE id = ${resourceId}::uuid
    `)
    await db.insert(resourceVersion).values({
      resourceId,
      version: 1,
      storageKey: live.versionKey,
      // A version whose DuckLake ingest was deferred names the Parquet it still
      // has to be read from (ADR-043 §6-6); the retry's queue message is a
      // reference this check cannot see, so the pointer is what it asks about.
      lakeSourceKey: live.lakeSourceKey,
      size: 1,
      hash: 'h',
      origin: 'upload',
    })
    await db.insert(resourcePipeline).values({
      resourceId,
      previewKey: live.previewKey,
      metadata: { textHeadKey: live.textHeadKey },
    })
    for (const key of Object.values(live)) await due(key)
    await due('orphan/nothing-points-here')

    const { storage, deleted } = fakeStorage()
    const result = await sweepOrphanedObjects(db, storage, log)

    expect(deleted).toEqual(['orphan/nothing-points-here'])
    expect(result).toEqual({ scanned: 7, deleted: 1, stillReferenced: 6 })
    // Both reasons to stop tracking a key end the same way — the object is
    // gone, or something references it after all and the record is the
    // leftover. Left in place either would be re-examined every hour for good.
    expect(await tracked()).toEqual([])
  })

  it('ignores a key whose expiry has not passed', async () => {
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at)
      VALUES ('reserved/in-flight', NOW() + INTERVAL '1 hour')
    `)

    const { storage, deleted } = fakeStorage()

    expect(await sweepOrphanedObjects(db, storage, log)).toEqual({
      scanned: 0,
      deleted: 0,
      stillReferenced: 0,
    })
    expect(deleted).toEqual([])
    expect(await tracked()).toEqual(['reserved/in-flight'])
  })

  it('keeps tracking a key the backend failed to delete', async () => {
    await due('orphan/stubborn')
    const storage = { deleteMany: async () => [] } as unknown as StorageAdapter

    expect(await sweepOrphanedObjects(db, storage, log)).toMatchObject({ deleted: 0 })
    expect(await tracked()).toEqual(['orphan/stubborn'])
  })
})
