/**
 * Integration tests for the one-off reconciliation (ADR-045 open issue 1).
 *
 * Against a real database for the same reason the sweep's are: the decision of
 * what is a leak comes out of one statement over the live pointer columns, and
 * a mock cannot tell you whether that statement asks about all of them. Here it
 * matters twice over — this is the path that finds objects no writer nominated,
 * so a source missing from the check is a live file handed to a delete.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { ListedObject, StorageAdapter } from '@kukan/storage-adapter'
import type { Logger } from '@kukan/shared'
import { reconcileOrphanedObjects } from '../../cron/orphan-cleanup/reconcile-orphans'
import { sweepOrphanedObjects } from '../../cron/orphan-cleanup/sweep-orphans'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const log = { info: vi.fn() } as unknown as Logger

const OLD = new Date('2020-01-01T00:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A bucket that hands back one page per prefix, and records which prefixes were
 * asked for. Keys are grouped by their own prefix, as a real listing does.
 */
function fakeBucket(objects: ListedObject[]) {
  const asked: string[] = []
  const storage = {
    list: async (prefix: string, token?: string) => {
      asked.push(prefix)
      expect(token).toBeUndefined()
      return { objects: objects.filter((o) => o.key.startsWith(prefix)) }
    },
  } as unknown as StorageAdapter
  return { storage, asked }
}

/** A page big enough to force the caller to paginate. */
function pagedBucket(pages: ListedObject[][]) {
  const storage = {
    list: async (prefix: string, token?: string) => {
      if (prefix !== 'resources/') return { objects: [] }
      const i = token ? Number(token) : 0
      return {
        objects: pages[i] ?? [],
        nextToken: i + 1 < pages.length ? String(i + 1) : undefined,
      }
    },
  } as unknown as StorageAdapter
  return { storage }
}

const obj = (key: string, lastModified = OLD): ListedObject => ({ key, lastModified })

/** Deletes everything the sweep hands it, and remembers what that was. */
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

async function tracked(): Promise<string[]> {
  const rows = await db.execute(sql`SELECT key FROM orphaned_object ORDER BY key`)
  return (rows.rows as unknown as { key: string }[]).map((r) => r.key)
}

let packageId: string
let resourceId: string

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-reconcile', 'active') RETURNING id
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

describe('reconcileOrphanedObjects', () => {
  it('nominates only what no pointer names, across every source', async () => {
    // One live object per pointer source. Asserted together rather than one
    // test each: the exhaustiveness of the list is the invariant, and this is
    // the path where getting it wrong costs a file nobody parked.
    const live = {
      storageKey: 'resources/live-current',
      pendingStorageKey: 'resources/live-pending',
      versionKey: 'versions/live-version',
      previewKey: 'previews/live-preview',
      textHeadKey: 'previews/live-text-head',
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
      size: 1,
      hash: 'h',
      origin: 'upload',
    })
    await db.insert(resourcePipeline).values({
      resourceId,
      previewKey: live.previewKey,
      metadata: { textHeadKey: live.textHeadKey },
    })

    const { storage, asked } = fakeBucket([
      ...Object.values(live).map((k) => obj(k)),
      obj('resources/leaked'),
      obj('versions/leaked'),
      obj('previews/leaked'),
    ])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: false,
    })

    expect(result).toMatchObject({ listed: 8, referenced: 5, nominated: 3, tooRecent: 0 })
    expect(await tracked()).toEqual(['previews/leaked', 'resources/leaked', 'versions/leaked'])
    // `lake/` is DuckLake's to reclaim, and ADR-045 §5 declined to build a
    // second thing that thinks it knows that layout.
    expect(asked).toEqual(['resources/', 'previews/', 'versions/'])
  })

  it('writes nothing in a dry run, but reports what it would do', async () => {
    const { storage } = fakeBucket([obj('resources/leaked')])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: true,
    })

    expect(result).toMatchObject({ nominated: 1, samples: ['resources/leaked'] })
    expect(await tracked()).toEqual([])
  })

  it('defers a recent object rather than acting, since a write in flight looks like a leak', async () => {
    // The object is there and no pointer names it yet — which is what an
    // upload mid-flight looks like from a listing.
    const { storage } = fakeBucket([obj('resources/just-written', new Date())])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: false,
    })

    expect(result).toMatchObject({ listed: 1, tooRecent: 1, nominated: 0 })
    expect(await tracked()).toEqual([])
  })

  it('counts a young object as deferred only when it is also unreferenced and untracked', async () => {
    // Age is judged last. Weighed first, every ordinary recent object would land
    // in `tooRecent`, drowning the ones that actually need another look — and a
    // young untracked leak would be indistinguishable from a live file, so
    // `nominated: 0` would read as "finished" with the leak still there.
    await db.execute(sql`
      UPDATE resource SET storage_key = 'resources/young-live' WHERE id = ${resourceId}::uuid
    `)
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at)
      VALUES ('resources/young-reserved', NOW() + INTERVAL '1 hour')
    `)
    const now = new Date()
    const { storage } = fakeBucket([
      obj('resources/young-live', now),
      obj('resources/young-reserved', now),
      obj('resources/young-leak', now),
    ])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: true,
    })

    // Only the third is unaccounted for, so only it defers a verdict.
    expect(result).toMatchObject({
      listed: 3,
      referenced: 1,
      alreadyTracked: 1,
      tooRecent: 1,
      nominated: 0,
    })
  })

  it('counts a key the ledger already holds apart from what it nominates', async () => {
    // `nominated` is the completion signal — run this until it is zero. Ordinary
    // parked keys are unreferenced by construction and their objects are old
    // enough to pass the age guard, so counting them here would keep that number
    // off zero for as long as the system is in use.
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at)
      VALUES ('resources/parked', NOW() + INTERVAL '1 hour')
    `)
    const { storage } = fakeBucket([obj('resources/parked'), obj('resources/leaked')])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: false,
    })

    expect(result).toMatchObject({ alreadyTracked: 1, nominated: 1, samples: ['resources/leaked'] })
  })

  it('does not move an expiry a writer already set', async () => {
    // The writer knows when its own write may be given up on; a listing does
    // not. Pushing the record out here would keep resetting that clock.
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at)
      VALUES ('resources/reserved', NOW() - INTERVAL '1 minute')
    `)
    const { storage } = fakeBucket([obj('resources/reserved')])

    await reconcileOrphanedObjects(db, storage, log, { minAgeMs: DAY_MS, dryRun: false })

    // Compared in SQL: the expiry is a timestamptz, and what matters is that it
    // is still the past one the writer chose rather than an hour from now.
    const [row] = (
      await db.execute(sql`
        SELECT expires_at < NOW() AS untouched FROM orphaned_object
        WHERE key = 'resources/reserved'
      `)
    ).rows as unknown as { untouched: boolean }[]
    expect(row.untouched).toBe(true)
  })

  it('hands a nomination to the sweep, which keeps a key that became live meanwhile', async () => {
    // The claim this design rests on. Nominating is not deciding: the sweep
    // asks again immediately before deleting, so a pointer that commits between
    // the listing and the deletion saves its object. Being wrong here costs a
    // row, not a file — which is why reconciliation is safe to run at all.
    const { storage } = fakeBucket([obj('resources/leaked'), obj('resources/raced')])
    await reconcileOrphanedObjects(db, storage, log, { minAgeMs: DAY_MS, dryRun: false })
    expect(await tracked()).toEqual(['resources/leaked', 'resources/raced'])

    // A write finishes after the listing decided it was a leak.
    await db.execute(sql`
      UPDATE resource SET storage_key = 'resources/raced' WHERE id = ${resourceId}::uuid
    `)
    // Past the wait, so the sweep is free to act on both.
    await db.execute(sql`UPDATE orphaned_object SET expires_at = NOW() - INTERVAL '1 minute'`)

    const swept = fakeStorage()
    const result = await sweepOrphanedObjects(db, swept.storage, log)

    expect(swept.deleted).toEqual(['resources/leaked'])
    expect(result).toMatchObject({ deleted: 1, stillReferenced: 1 })
    // Both stop being tracked: one because its object is gone, the other
    // because the nomination turned out to be the leftover.
    expect(await tracked()).toEqual([])
  })

  it('follows the continuation token to the end of a prefix', async () => {
    const { storage } = pagedBucket([
      [obj('resources/a')],
      [obj('resources/b')],
      [obj('resources/c')],
    ])

    const result = await reconcileOrphanedObjects(db, storage, log, {
      minAgeMs: DAY_MS,
      dryRun: false,
    })

    expect(result).toMatchObject({ listed: 3, nominated: 3 })
    expect(await tracked()).toEqual(['resources/a', 'resources/b', 'resources/c'])
  })
})
