/**
 * The search-document sync works through every marked resource, and clearing
 * each mark is a compare-and-set (ADR-053 §9.3).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { isLockTimeout, organization, packageTable, resource, type Transaction } from '@kukan/db'
import { BulkIndexError, type ResourceDoc, type SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { createLogger } from '@kukan/shared'
import {
  lockInTransaction,
  RESOURCE_DOC_SYNC_LOCK,
  withGlobalAdvisoryLock,
} from '../../services/advisory-lock'
import { PackageService } from '../../services/package-service'
import {
  dropIndexedWithoutRow,
  enqueueResourceDocSyncIfDue,
  rebuildMetadataIndex,
  syncDueResourceDocs,
  writeMarkedResourceDocs,
} from '../../services/search-index'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

async function seed(opts: { due?: boolean; packageState?: string; state?: string } = {}) {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `pkg-${crypto.randomUUID()}`, state: opts.packageState ?? 'active' })
    .returning({ id: packageTable.id })
  const [row] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: 'r.csv',
      state: opts.state ?? 'active',
      docSyncDueAt: opts.due === false ? null : sql`NOW() - interval '1 minute'`,
    })
    .returning({ id: resource.id })
  return row.id
}

const dueAt = async (id: string) =>
  (await db.select({ d: resource.docSyncDueAt }).from(resource).where(eq(resource.id, id)))[0].d

function fakeSearch(onWrite?: (docs: ResourceDoc[]) => Promise<void>) {
  const bulkIndexResources = vi.fn(async (docs: ResourceDoc[]) => {
    await onWrite?.(docs)
  })
  const deleteResources = vi.fn(async (_ids: string[]) => {})
  return {
    search: { bulkIndexResources, deleteResources } as unknown as SearchAdapter,
    bulkIndexResources,
    deleteResources,
  }
}

/** Run `take` in another transaction and hold what it took until the returned release */
async function holdInTransaction(take: (tx: Transaction) => Promise<unknown>) {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let taken!: () => void
  const isTaken = new Promise<void>((r) => (taken = r))
  const holder = db.transaction(async (tx) => {
    await take(tx)
    taken()
    await held
  })
  await isTaken
  return async () => {
    release()
    await holder
  }
}

const holdDocSyncLock = () =>
  holdInTransaction((tx) => lockInTransaction(tx, RESOURCE_DOC_SYNC_LOCK, ''))

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('syncDueResourceDocs', () => {
  it('writes every marked document in one request and clears their marks', async () => {
    const a = await seed()
    const b = await seed()
    const { search, bulkIndexResources } = fakeSearch()

    expect(await syncDueResourceDocs(db, search)).toEqual({ synced: 2, refused: [] })

    expect(bulkIndexResources).toHaveBeenCalledOnce()
    expect(bulkIndexResources.mock.calls[0][0].map((d) => d.id).sort()).toEqual([a, b].sort())
    expect(await dueAt(a)).toBeNull()
    expect(await dueAt(b)).toBeNull()
  })

  it('writes nothing for a resource with no mark', async () => {
    await seed({ due: false })
    const { search, bulkIndexResources } = fakeSearch()

    expect(await syncDueResourceDocs(db, search)).toEqual({ synced: 0, refused: [] })
    expect(bulkIndexResources).not.toHaveBeenCalled()
  })

  it('carries an edit that landed while it was writing, instead of dropping it', async () => {
    // A hide made in that window must not be dropped: the projection takes a
    // hidden abstract off the document, and clearing regardless would leave
    // text somebody took down answering searches.
    const id = await seed()
    let edited = false
    const { search, bulkIndexResources } = fakeSearch(async () => {
      if (edited) return
      edited = true
      await db
        .update(resource)
        .set({ docSyncDueAt: sql`NOW()` })
        .where(eq(resource.id, id))
    })

    await syncDueResourceDocs(db, search)

    // The first write's clear missed, so the row was taken again and written
    // from what it says now
    expect(bulkIndexResources).toHaveBeenCalledTimes(2)
    expect(await dueAt(id)).toBeNull()
  })

  it('removes the document of a resource deleted while marked, instead of writing it', async () => {
    // A sync that read the row while it was active can write the document back
    // after the delete removed it; the delete's mark is what undoes that
    const live = await seed()
    const gone = await seed({ state: 'deleted' })
    const { search, bulkIndexResources, deleteResources } = fakeSearch()

    expect(await syncDueResourceDocs(db, search)).toEqual({ synced: 2, refused: [] })

    expect(bulkIndexResources.mock.calls[0][0].map((d) => d.id)).toEqual([live])
    expect(deleteResources).toHaveBeenCalledWith([gone])
    expect(await dueAt(gone)).toBeNull()
  })

  it('removes the documents of a deleted dataset, whose resources the delete marked', async () => {
    // A writer that read them while the dataset was live may have written
    // them back after the delete took them
    const id = await seed({ packageState: 'deleted' })
    const { search, bulkIndexResources, deleteResources } = fakeSearch()

    await syncDueResourceDocs(db, search)

    expect(bulkIndexResources).not.toHaveBeenCalled()
    expect(deleteResources).toHaveBeenCalledWith([id])
    expect(await dueAt(id)).toBeNull()
  })

  it('throws when the index fails a removal, for the queue to retry, and clears nothing', async () => {
    // The index's failure, not one document's: taken as a refusal, the job
    // would succeed and the retry would wait for the sweep
    const gone = await seed({ state: 'deleted' })
    const live = await seed()
    const { search, deleteResources } = fakeSearch()
    deleteResources.mockRejectedValueOnce(new Error('index unreachable'))

    await expect(syncDueResourceDocs(db, search)).rejects.toThrow('index unreachable')
    expect(await dueAt(live)).not.toBeNull()
    expect(await dueAt(gone)).not.toBeNull()
  })

  it("clears a draft's mark without writing, the index holding nothing of it until publish", async () => {
    // Left, the marks of drafts never published would pile up in front of
    // every batch
    const id = await seed({ packageState: 'draft' })
    const { search, bulkIndexResources, deleteResources } = fakeSearch()

    await syncDueResourceDocs(db, search)

    expect(bulkIndexResources).not.toHaveBeenCalled()
    expect(deleteResources).not.toHaveBeenCalled()
    expect(await dueAt(id)).toBeNull()
  })

  it('clears the rest when the index refuses one document, and keeps that one marked', async () => {
    // Read oldest first, a refused row would otherwise hold back every mark
    // behind it on every retry
    const bad = await seed()
    const good = await seed()
    const { search } = fakeSearch(async () => {
      throw new BulkIndexError([bad])
    })

    expect(await syncDueResourceDocs(db, search)).toEqual({
      synced: 1,
      refused: [bad],
    })
    expect(await dueAt(good)).toBeNull()
    expect(await dueAt(bad)).not.toBeNull()
  })

  it('leaves the marks when the write fails, for the retry', async () => {
    const id = await seed()
    const { search } = fakeSearch(async () => {
      throw new Error('index unreachable')
    })

    await expect(syncDueResourceDocs(db, search)).rejects.toThrow('index unreachable')
    expect(await dueAt(id)).not.toBeNull()
  })

  it('gives up on a row another transaction holds too long, leaving its marks for the retry', async () => {
    // Waiting on, it would keep every edit off the lock. The documents it
    // wrote stand; only the clearing is rolled back.
    const id = await seed()
    const { search, bulkIndexResources } = fakeSearch()
    const release = await holdInTransaction((tx) =>
      tx.execute(sql`SELECT id FROM resource WHERE id = ${id} FOR UPDATE`)
    )

    const sync = syncDueResourceDocs(db, search, { rowLockWaitMs: 200 })
    await expect(sync).rejects.toSatisfy(isLockTimeout)
    expect(bulkIndexResources).toHaveBeenCalledOnce()
    expect(await dueAt(id)).not.toBeNull()

    await release()
  })

  it('waits its turn while another writer holds the lock, then writes', async () => {
    // Two at once could land one resource's documents out of order
    const id = await seed()
    const { search, bulkIndexResources } = fakeSearch()
    const release = await holdDocSyncLock()

    const sync = syncDueResourceDocs(db, search)
    await new Promise((r) => setTimeout(r, 100))
    expect(bulkIndexResources).not.toHaveBeenCalled()

    await release()
    expect(await sync).toEqual({ synced: 1, refused: [] })
    expect(await dueAt(id)).toBeNull()
  })
})

describe('writeMarkedResourceDocs', () => {
  function deps(search: SearchAdapter) {
    const enqueue = vi.fn().mockResolvedValue('job')
    return {
      deps: {
        search,
        queue: { enqueue } as unknown as QueueAdapter,
        ai: {} as AIAdapter,
        logger: createLogger({ name: 'test', level: 'silent' }),
      },
      enqueue,
    }
  }

  it("writes an edit's document under the lock and clears its mark, asking for no job", async () => {
    const id = await seed()
    const other = await seed()
    const { search, bulkIndexResources } = fakeSearch()
    const { deps: d, enqueue } = deps(search)

    await writeMarkedResourceDocs(db, d, { resourceIds: [id] })

    expect(bulkIndexResources.mock.calls[0][0].map((doc) => doc.id)).toEqual([id])
    expect(await dueAt(id)).toBeNull()
    // Only what it was given: the others are the job's
    expect(await dueAt(other)).not.toBeNull()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('leaves the document to the job, without waiting or writing, while a sync holds the lock', async () => {
    // Waiting, a request holds a pooled connection that other requests need.
    // Writing without the lock, it could land after the job had written a
    // later edit and cleared its mark — a hidden abstract searchable again.
    const id = await seed()
    const { search, bulkIndexResources } = fakeSearch()
    const { deps: d, enqueue } = deps(search)
    const release = await holdDocSyncLock()

    await writeMarkedResourceDocs(db, d, { resourceIds: [id] })

    expect(bulkIndexResources).not.toHaveBeenCalled()
    expect(await dueAt(id)).not.toBeNull()
    expect(enqueue).toHaveBeenCalledWith('sync-resource-doc', {}, { unlessWaiting: true })
    await release()
  })

  it('asks for no job when nothing in its scope is marked, even with the lock held', async () => {
    const id = await seed({ due: false })
    const { search } = fakeSearch()
    const { deps: d, enqueue } = deps(search)
    const release = await holdDocSyncLock()

    await writeMarkedResourceDocs(db, d, { resourceIds: [id] })
    await writeMarkedResourceDocs(db, d, { resourceIds: [] })

    expect(enqueue).not.toHaveBeenCalled()
    await release()
  })

  it('writes one batch at most, and leaves the rest of a large dataset to the job', async () => {
    // A request is not made to carry a whole dataset's documents
    const first = await seed()
    const [{ packageId }] = await db
      .select({ packageId: resource.packageId })
      .from(resource)
      .where(eq(resource.id, first))
    await db.insert(resource).values(
      Array.from({ length: 200 }, (_, i) => ({
        packageId,
        name: `r${i}.csv`,
        state: 'active',
        docSyncDueAt: sql`NOW()`,
      }))
    )
    const { search, bulkIndexResources } = fakeSearch()
    const { deps: d, enqueue } = deps(search)

    await writeMarkedResourceDocs(db, d, { packageId })

    expect(bulkIndexResources).toHaveBeenCalledOnce()
    expect(bulkIndexResources.mock.calls[0][0]).toHaveLength(200)
    expect(enqueue).toHaveBeenCalledWith('sync-resource-doc', {}, { unlessWaiting: true })
  })
})

describe('rebuildMetadataIndex', () => {
  it('takes its turn at the sync lock before reading a batch', async () => {
    // Read outside it, a batch could put back the document an edit had just
    // written and cleared the mark for
    await seed({ due: false })
    const bulkIndexResources = vi.fn(async () => {})
    const search = {
      bulkIndexPackages: vi.fn(async () => {}),
      bulkIndexResources,
      indexedDocumentIds: vi.fn(async () => []),
    } as unknown as SearchAdapter
    const release = await holdDocSyncLock()

    const rebuild = rebuildMetadataIndex(
      db,
      search,
      createLogger({ name: 'test', level: 'silent' })
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(bulkIndexResources).not.toHaveBeenCalled()

    await release()
    await rebuild
    expect(bulkIndexResources).toHaveBeenCalledOnce()
  })
})

describe('dropIndexedWithoutRow', () => {
  it('runs each page the way it is given, so a caller can hold a lock over one page', async () => {
    // A page at a time: held over the whole walk, a large index would keep
    // every edit waiting for as long as the walk ran
    const remove = vi.fn(async (_ids: string[]) => {})
    const drop = (runPage: Parameters<typeof dropIndexedWithoutRow>[3]) =>
      dropIndexedWithoutRow(
        async (after) => (after ? [] : ['gone-1']),
        async () => [],
        remove,
        runPage
      )
    const release = await holdDocSyncLock()

    // Run as it is, the holder is no obstacle
    expect(await drop((page) => page(db))).toBe(1)
    remove.mockClear()

    const locked = drop((page) => withGlobalAdvisoryLock(db, RESOURCE_DOC_SYNC_LOCK, page))
    await new Promise((r) => setTimeout(r, 100))
    expect(remove).not.toHaveBeenCalled()

    await release()
    expect(await locked).toBe(1)
  })
})

describe('enqueueResourceDocSyncIfDue', () => {
  it('asks for the sync only when the resource is marked', async () => {
    // Once at the end of a run, whichever of its writes marked the row
    const marked = await seed()
    const clean = await seed({ due: false })
    const enqueue = vi.fn().mockResolvedValue('job')
    const queue = { enqueue } as unknown as QueueAdapter
    const log = createLogger({ name: 'test', level: 'silent' })

    await enqueueResourceDocSyncIfDue(db, queue, clean, log)
    expect(enqueue).not.toHaveBeenCalled()

    await enqueueResourceDocSyncIfDue(db, queue, marked, log)
    expect(enqueue).toHaveBeenCalledWith('sync-resource-doc', {}, { unlessWaiting: true })
  })
})

describe('publish and restore', () => {
  /** A dataset in `state` with one live, unmarked resource */
  async function seedDataset(state: 'draft' | 'deleted') {
    const [org] = await db
      .insert(organization)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning({ id: organization.id })
    const [pkg] = await db
      .insert(packageTable)
      .values({ name: `pkg-${crypto.randomUUID()}`, state, ownerOrg: org.id, licenseId: 'cc-by' })
      .returning({ id: packageTable.id })
    const [row] = await db
      .insert(resource)
      .values({ packageId: pkg.id, name: 'r.csv', state: 'active' })
      .returning({ id: resource.id })
    return { packageId: pkg.id, resourceId: row.id }
  }

  it.each([
    ['publishes', 'draft', (id: string) => new PackageService(db).publish(id)],
    ['restores', 'deleted', (id: string) => new PackageService(db).restore(id)],
  ] as const)(
    'marks the resources in the transaction that %s the dataset',
    async (_, state, go) => {
      // Marked after the commit instead, a crash before the sync would leave a
      // live dataset with no resource documents and nothing to say so
      const { packageId, resourceId } = await seedDataset(state)

      await go(packageId)

      expect(await dueAt(resourceId)).not.toBeNull()
    }
  )
})
