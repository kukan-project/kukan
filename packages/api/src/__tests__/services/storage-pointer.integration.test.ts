/**
 * Integration tests for the live-content pointer (ADR-043).
 *
 * The invariant under test: a resource row always describes the object it
 * names, and whatever stops being named is parked for the sweep rather than
 * deleted underneath a reader.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { resource } from '@kukan/db'
import { getStorageKey } from '@kukan/shared'
import {
  expirePendingUploads,
  publishLiveContent,
  reserveObject,
} from '../../services/storage-pointer'
import { ResourceService } from '../../services/resource-service'
import {
  CLAIM_STALE_AFTER_MS,
  claimResources,
  type ResourceClaim,
} from '../../services/pipeline-claim'
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

  it('empties the resource, parking what it was holding', async () => {
    // A revert with nothing left to go back to. The same conditional move, so
    // the object it replaces is parked the same way (ADR-044 §4).
    const live = getStorageKey(packageId, resourceId, 'live')
    await publishLiveContent(db, resourceId, {
      key: live,
      previousKey: null,
      hash: 'sha256:a',
      size: 10,
      previousHash: null,
    })

    expect(
      await publishLiveContent(db, resourceId, {
        key: null,
        previousKey: live,
        hash: null,
        size: null,
        previousHash: 'sha256:a',
      })
    ).toBe(true)

    const r = await row()
    expect(r.storageKey).toBeNull()
    expect(r.hash).toBeNull()
    expect(await parkedKeys()).toEqual([live])
  })

  it('refuses to empty a pointer that moved, and parks nothing', async () => {
    // Uploads take no claim (ADR-044 §6), so a promote can land while a revert
    // is deciding. Clearing anyway would delete the winner's content.
    const newer = getStorageKey(packageId, resourceId, 'newer')
    await db.update(resource).set({ storageKey: newer }).where(eq(resource.id, resourceId))

    expect(
      await publishLiveContent(db, resourceId, {
        key: null,
        previousKey: getStorageKey(packageId, resourceId, 'stale'),
        hash: null,
        size: null,
        previousHash: null,
      })
    ).toBe(false)

    expect((await row()).storageKey).toBe(newer)
    // Nothing of its own to park: this operation wrote no object.
    expect(await parkedKeys()).toEqual([])
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

  it('holds the replacement metadata until the upload is promoted', async () => {
    // An abandoned upload must leave the resource describing the content it is
    // still serving. A CSV replaced by a PDF that never arrives would otherwise
    // be served as the old CSV under a PDF's name, MIME type and format — and
    // the preview would branch on the format of a file that is not there.
    const service = new ResourceService(db)
    const before = await row()

    const pending = await service.prepareForUpload(resourceId, {
      filename: 'data.json',
      contentType: 'application/json',
      format: 'GeoJSON',
    })

    const held = await row()
    expect(held.url).toBe(before.url)
    expect(held.urlType).toBe(before.urlType)
    expect(held.format).toBe(before.format)
    expect(held.mimetype).toBe(before.mimetype)

    await service.promoteUpload(resourceId, pending, { size: 42 })

    // Format resolution is explicit > filename > whatever the resource had.
    const after = await row()
    expect(after.format).toBe('GeoJSON')
    expect(after.urlType).toBe('upload')
    expect(after.url).toBe('data.json')
    expect(after.mimetype).toBe('application/json')
    expect(after.pendingMetadata).toBeNull()
  })

  it('derives the format from the filename when none is given', async () => {
    const service = new ResourceService(db)
    const pending = await service.prepareForUpload(resourceId, {
      filename: 'report.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    await service.promoteUpload(resourceId, pending, { size: 42 })

    expect((await row()).format).toBe('XLSX')
  })

  it('drops the held metadata when the upload is never completed', async () => {
    // The sweep reclaims the key; the description it would have applied must go
    // with it, or a later promotion would apply a name from an upload that was
    // abandoned days earlier.
    const service = new ResourceService(db)
    await service.prepareForUpload(resourceId, {
      filename: 'data.csv',
      contentType: 'text/csv',
    })
    await db
      .update(resource)
      .set({ pendingStorageKeyAt: sql`NOW() - interval '2 days'` })
      .where(eq(resource.id, resourceId))

    expect(await expirePendingUploads(db, 60_000)).toBe(1)
    expect((await row()).pendingMetadata).toBeNull()
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

describe('prepareForUpload — stopping the run it replaces', () => {
  const service = new ResourceService(db)

  async function runInFlight(): Promise<ResourceClaim> {
    const [pipe] = await db
      .execute(
        sql`
      INSERT INTO resource_pipeline (resource_id, status) VALUES (${resourceId}::uuid, 'processing')
      RETURNING id
    `
      )
      .then((r) => r.rows as unknown as { id: string }[])
    const { claimed } = await claimResources(
      db,
      [resourceId],
      randomUUID(),
      CLAIM_STALE_AFTER_MS,
      'run'
    )
    expect(claimed).toHaveLength(1)
    expect(claimed[0].id).toBe(pipe.id)
    return claimed[0]
  }

  async function pipeline() {
    const rows = await db.execute(sql`
      SELECT status, claim_owner FROM resource_pipeline WHERE resource_id = ${resourceId}::uuid
    `)
    return rows.rows[0] as { status: string; claim_owner: string | null }
  }

  it('stops the run processing the content being replaced', async () => {
    // Uploads do not take the claim, so without this whether the run notices it
    // was overtaken is chance — and one that does not notice goes on feeding
    // the content the user is retracting into the search index (ADR-044 §4).
    await runInFlight()

    await service.prepareForUpload(resourceId, {
      filename: 'right.csv',
      contentType: 'text/csv',
    })

    const row = await pipeline()
    expect(row.claim_owner).toBeNull()
    expect(row.status).toBe('cancelled')
  })

  it('leaves the live content alone', async () => {
    // The replacement has not arrived yet. Reverting is a separate choice.
    const live = getStorageKey(packageId, resourceId, 'live')
    await db.update(resource).set({ storageKey: live }).where(eq(resource.id, resourceId))
    await runInFlight()

    await service.prepareForUpload(resourceId, {
      filename: 'right.csv',
      contentType: 'text/csv',
    })

    expect((await row()).storageKey).toBe(live)
  })

  it('is a no-op when nothing is running', async () => {
    await db.execute(sql`
      INSERT INTO resource_pipeline (resource_id, status) VALUES (${resourceId}::uuid, 'complete')
    `)

    await service.prepareForUpload(resourceId, {
      filename: 'right.csv',
      contentType: 'text/csv',
    })

    expect((await pipeline()).status).toBe('complete')
  })
})

describe('the write-ahead record (ADR-045)', () => {
  async function ledger(): Promise<{ key: string; expires: number }[]> {
    const rows = await db.execute(sql`SELECT key, expires_at FROM orphaned_object ORDER BY key`)
    return (rows.rows as unknown as { key: string; expires_at: string }[]).map((r) => ({
      key: r.key,
      expires: new Date(r.expires_at).getTime(),
    }))
  }

  it('records a key before its object exists, with a deadline of its own', async () => {
    // Without this there is no path back to an object whose writer died before
    // anything referenced it: no row names it, and no sweep looks for it.
    const key = getStorageKey(packageId, resourceId, 'run')

    await reserveObject(db, key)

    const [row] = await ledger()
    expect(row.key).toBe(key)
    expect(row.expires).toBeGreaterThan(Date.now())
  })

  it('drops the record once the pointer references the key', async () => {
    const key = getStorageKey(packageId, resourceId, 'run')
    await reserveObject(db, key)

    await publishLiveContent(db, resourceId, {
      key,
      previousKey: null,
      hash: 'sha256:a',
      size: 1,
      previousHash: null,
    })

    expect(await ledger()).toEqual([])
  })

  it('keeps the record when the pointer move loses', async () => {
    // The run was overtaken, so its object is garbage rather than content —
    // exactly what the sweep should collect.
    const live = getStorageKey(packageId, resourceId, 'live')
    await db.update(resource).set({ storageKey: live }).where(eq(resource.id, resourceId))
    const key = getStorageKey(packageId, resourceId, 'late')
    await reserveObject(db, key)

    const published = await publishLiveContent(db, resourceId, {
      key,
      previousKey: null, // this run started from an empty pointer; it has moved
      hash: 'sha256:a',
      size: 1,
      previousHash: null,
    })

    expect(published).toBe(false)
    expect((await ledger()).map((r) => r.key)).toContain(key)
  })

  it('pushes the expiry out when the same key is reserved again', async () => {
    // Version keys are derived from the version number, so a retried capture
    // reserves the one the failed attempt did. Inheriting that attempt's expiry
    // would leave the sweep free to delete the object mid-write.
    const key = getStorageKey(packageId, resourceId, 'retried')
    await db.execute(sql`
      INSERT INTO orphaned_object (key, expires_at) VALUES (${key}, NOW() - INTERVAL '1 minute')
    `)

    await reserveObject(db, key)

    const [row] = await ledger()
    expect(row.expires).toBeGreaterThan(Date.now())
  })
})
