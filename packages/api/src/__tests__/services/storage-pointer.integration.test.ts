/**
 * Integration tests for the live-content pointer (ADR-043).
 *
 * The invariant under test: a resource row always describes the object it
 * names, and whatever stops being named is parked for the sweep rather than
 * deleted underneath a reader.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { resource } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import { publishLiveContent } from '../../services/storage-pointer'
import { ResourceService } from '../../services/resource-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let packageId: string
let resourceId: string

async function parkedKeys(): Promise<string[]> {
  const rows = await db.execute(sql`SELECT key FROM orphaned_object ORDER BY key`)
  return (rows.rows as unknown as { key: string }[]).map((r) => r.key)
}

async function row() {
  const [r] = await db.select().from(resource).where(eq(resource.id, resourceId))
  return r
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-live-content', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'link', url: 'https://example.com/data.csv' })
    .returning()
  resourceId = res.id
})

afterAll(async () => {
  await closeTestDb()
})

describe('publishLiveContent', () => {
  it('moves the pointer and its values together, parking what it replaced', async () => {
    const first = getStorageKey(packageId, resourceId, 'run-1')
    expect(
      await publishLiveContent(db, resourceId, {
        key: first,
        previousKey: null,
        hash: 'sha256:a',
        size: 10,
        previousHash: null,
      })
    ).toBe(true)
    // Nothing to park on the first publish.
    expect(await parkedKeys()).toEqual([])

    const second = getStorageKey(packageId, resourceId, 'run-2')
    expect(
      await publishLiveContent(db, resourceId, {
        key: second,
        previousKey: first,
        hash: 'sha256:b',
        size: 20,
        previousHash: 'sha256:a',
      })
    ).toBe(true)

    const r = await row()
    expect(r.storageKey).toBe(second)
    expect(r.hash).toBe('sha256:b')
    expect(r.size).toBe(20)
    expect(await parkedKeys()).toEqual([first])
  })

  it('refuses to publish over a pointer that moved, and parks its own object', async () => {
    // Two runs fetch concurrently. Whichever publishes first owns the resource;
    // the other must not pull it back to bytes that are no longer the content.
    const winner = getStorageKey(packageId, resourceId, 'winner')
    const loser = getStorageKey(packageId, resourceId, 'loser')

    await publishLiveContent(db, resourceId, {
      key: winner,
      previousKey: null,
      hash: 'sha256:winner',
      size: 10,
      previousHash: null,
    })
    const published = await publishLiveContent(db, resourceId, {
      key: loser,
      previousKey: null, // what the losing run read before the winner published
      hash: 'sha256:loser',
      size: 20,
      previousHash: null,
    })

    expect(published).toBe(false)
    const r = await row()
    expect(r.storageKey).toBe(winner)
    expect(r.hash).toBe('sha256:winner')
    // The losing run's object is the one nothing points at.
    expect(await parkedKeys()).toEqual([loser])
  })

  it('moves lastModified only when the content actually changed', async () => {
    const first = getStorageKey(packageId, resourceId, 'run-1')
    await publishLiveContent(db, resourceId, {
      key: first,
      previousKey: null,
      hash: 'sha256:a',
      size: 10,
      previousHash: null,
    })
    const changedAt = (await row()).lastModified
    expect(changedAt).not.toBeNull()

    // A scheduled re-fetch that finds the same bytes is not an edit.
    await publishLiveContent(db, resourceId, {
      key: getStorageKey(packageId, resourceId, 'run-2'),
      previousKey: first,
      hash: 'sha256:a',
      size: 10,
      previousHash: 'sha256:a',
    })

    expect((await row()).lastModified).toEqual(changedAt)
  })
})

describe('promoteUpload', () => {
  it('promotes the pending key and parks the object it replaced', async () => {
    const service = new ResourceService(db)
    const live = getStorageKey(packageId, resourceId, 'live')
    await db
      .update(resource)
      .set({ storageKey: live, hash: 'sha256:live', size: 5 })
      .where(eq(resource.id, resourceId))

    const prepared = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    // The live object still serves while the upload is only pending.
    expect(prepared.storageKey).toBe(live)
    expect(prepared.pendingStorageKey).not.toBe(live)
    expect(await parkedKeys()).toEqual([])

    const promoted = await service.promoteUpload(resourceId, { size: 42 })

    expect(promoted).toBe(prepared.pendingStorageKey)
    const r = await row()
    expect(r.storageKey).toBe(prepared.pendingStorageKey)
    expect(r.pendingStorageKey).toBeNull()
    expect(r.size).toBe(42)
    // Left for the worker to measure — a client-supplied hash would decide
    // what a version claims to hold.
    expect(r.hash).toBeNull()
    expect(await parkedKeys()).toEqual([live])
  })

  it('is a no-op on a repeated upload-complete', async () => {
    const service = new ResourceService(db)
    await service.prepareForUpload(resourceId, { filename: 'data.csv', contentType: 'text/csv' })
    const promoted = await service.promoteUpload(resourceId, { size: 42 })

    expect(await service.promoteUpload(resourceId, { size: 42 })).toBeNull()
    // The second call must not park the object the first one just published.
    expect(await parkedKeys()).toEqual([])
    expect((await row()).storageKey).toBe(promoted)
  })

  it('parks an upload URL that is reissued before it was used', async () => {
    const service = new ResourceService(db)
    const first = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    await service.prepareForUpload(resourceId, {
      filename: 'other.csv',
      contentType: 'text/csv',
    })

    // The client may already have written to the first URL.
    expect(await parkedKeys()).toEqual([first.pendingStorageKey])
  })
})
