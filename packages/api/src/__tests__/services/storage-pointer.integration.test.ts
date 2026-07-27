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
import { expirePendingUploads, publishLiveContent } from '../../services/storage-pointer'
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

    const pending = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    // The live object still serves while the upload is only pending.
    expect((await row()).storageKey).toBe(live)
    expect(pending).not.toBe(live)
    expect(await parkedKeys()).toEqual([])

    const promoted = await service.promoteUpload(resourceId, pending, { size: 42 })

    expect(promoted).toBe(pending)
    const r = await row()
    expect(r.storageKey).toBe(pending)
    expect(r.pendingStorageKey).toBeNull()
    expect(r.size).toBe(42)
    // Left for the worker to measure — a client-supplied hash would decide
    // what a version claims to hold.
    expect(r.hash).toBeNull()
    expect(await parkedKeys()).toEqual([live])
  })

  it('is a no-op on a repeated upload-complete', async () => {
    const service = new ResourceService(db)
    const pending = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    const promoted = await service.promoteUpload(resourceId, pending, { size: 42 })

    expect(await service.promoteUpload(resourceId, pending, { size: 42 })).toBeNull()
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
    expect(await parkedKeys()).toEqual([first])
  })

  it('parks an upload URL nobody used, once its window has passed', async () => {
    const service = new ResourceService(db)
    const pending = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })

    // Still inside the window: an upload may yet be in flight.
    expect(await expirePendingUploads(db, 60_000)).toBe(0)
    expect(await parkedKeys()).toEqual([])
    expect((await row()).pendingStorageKey).toBe(pending)

    await db
      .update(resource)
      .set({ pendingStorageKeyAt: sql`NOW() - interval '2 days'` })
      .where(eq(resource.id, resourceId))

    expect(await expirePendingUploads(db, 60_000)).toBe(1)
    expect(await parkedKeys()).toEqual([pending])
    const r = await row()
    expect(r.pendingStorageKey).toBeNull()
    expect(r.pendingStorageKeyAt).toBeNull()
    // The live content is untouched — only the unused upload URL went.
    expect(r.storageKey).toBeNull()
  })

  it('timestamps the pending key, and clears it on promotion', async () => {
    // The timestamp is what lets the sweep reclaim an upload URL nobody used.
    const service = new ResourceService(db)
    const pending = await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })

    expect((await row()).pendingStorageKeyAt).toBeInstanceOf(Date)

    await service.promoteUpload(resourceId, pending, { size: 42 })
    expect((await row()).pendingStorageKeyAt).toBeNull()
  })

  it('refuses to promote a key a newer upload replaced', async () => {
    // The losing request finished uploading to its own key and asked to
    // publish. Promoting "whatever is pending" would point the resource at the
    // winner's key — an object nobody has written yet — and describe it with
    // the size measured from the loser's.
    const service = new ResourceService(db)
    const first = await service.prepareForUpload(resourceId, {
      filename: 'first.csv',
      contentType: 'text/csv',
    })
    const second = await service.prepareForUpload(resourceId, {
      filename: 'second.csv',
      contentType: 'text/csv',
    })

    expect(await service.promoteUpload(resourceId, first, { size: 42 })).toBeNull()

    const r = await row()
    expect(r.storageKey).toBeNull()
    expect(r.pendingStorageKey).toBe(second)
    // Only the key `prepareForUpload` displaced is parked; the live pointer and
    // the winner's pending key are untouched.
    expect(await parkedKeys()).toEqual([first])
  })

  it('applies the replacement metadata it derives', async () => {
    // Moved here from the unit suite when prepare stopped returning the row:
    // format resolution is explicit > filename > whatever the resource had.
    const service = new ResourceService(db)

    await service.prepareForUpload(resourceId, {
      filename: 'data.json',
      contentType: 'application/json',
    })
    expect((await row()).format).toBe('JSON')

    await service.prepareForUpload(resourceId, {
      filename: 'data.json',
      contentType: 'application/json',
      format: 'GeoJSON',
    })
    const r = await row()
    expect(r.format).toBe('GeoJSON')
    expect(r.urlType).toBe('upload')
    expect(r.url).toBe('data.json')
    expect(r.mimetype).toBe('application/json')
  })

  it('parks the key the row actually held, not one the caller read earlier', async () => {
    // Routes pass the row they already fetched for the permission check. If the
    // replaced key came from that value rather than from the row itself, a
    // concurrent prepare would leave its key referenced by nothing and parked
    // by no one.
    const service = new ResourceService(db)
    const stale = await service.getById(resourceId)

    const first = await service.prepareForUpload(
      resourceId,
      { filename: 'first.csv', contentType: 'text/csv' },
      stale
    )
    // `stale` still says there is no pending key, but the row now holds `first`.
    const second = await service.prepareForUpload(
      resourceId,
      { filename: 'second.csv', contentType: 'text/csv' },
      stale
    )

    expect(await parkedKeys()).toEqual([first])
    expect((await row()).pendingStorageKey).toBe(second)
  })
})
