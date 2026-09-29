/**
 * The search-document sync works through every marked resource, and clearing
 * each mark is a compare-and-set (ADR-053 §9.3).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  group,
  isLockTimeout,
  organization,
  packageGroup,
  packageTable,
  resource,
  type Transaction,
} from '@kukan/db'
import {
  BulkIndexError,
  type DatasetDoc,
  type ResourceDoc,
  type SearchAdapter,
} from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { createLogger } from '@kukan/shared'
import { SEARCH_DOC_SYNC_LOCK, withGlobalAdvisoryLock } from '../../services/advisory-lock'
import { GroupService } from '../../services/group-service'
import { OrganizationService } from '../../services/organization-service'
import { PackageService } from '../../services/package-service'
import {
  dropIndexedWithoutRow,
  enqueueResourceDocSyncIfDue,
  rebuildMetadataIndex,
  syncDueSearchDocs,
  syncPackageMetadata,
  writeMarkedPackageDoc,
  writeMarkedResourceDocs,
} from '../../services/search-index'
import { purgePackagesSearchDocs } from '../../services/package-cleanup'
import { markPackageDocs } from '../../services/doc-marks'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'
import {
  holdDocSyncLock,
  holdDocSyncLockOffPool,
  holdInTransaction,
  packageDueAt,
} from '../test-helpers/doc-sync'

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

function fakeSearch(
  onWrite?: (docs: ResourceDoc[]) => Promise<void>,
  onPackageWrite?: (docs: DatasetDoc[]) => Promise<void>
) {
  const bulkIndexResources = vi.fn(async (docs: ResourceDoc[]) => {
    await onWrite?.(docs)
  })
  const deleteResources = vi.fn(async (_ids: string[]) => {})
  const bulkIndexPackages = vi.fn(async (docs: DatasetDoc[]) => {
    if (docs.length > 0) await onPackageWrite?.(docs)
  })
  const deletePackage = vi.fn(async (_id: string) => {})
  return {
    search: {
      bulkIndexResources,
      deleteResources,
      bulkIndexPackages,
      deletePackage,
    } as unknown as SearchAdapter,
    bulkIndexResources,
    deleteResources,
    bulkIndexPackages,
    deletePackage,
  }
}

/** A route's context, with the queue it asks the job of */
function deps(search: SearchAdapter, ai: AIAdapter = {} as AIAdapter) {
  const enqueue = vi.fn().mockResolvedValue('job')
  return {
    deps: {
      search,
      queue: { enqueue } as unknown as QueueAdapter,
      ai,
      logger: createLogger({ name: 'test', level: 'silent' }),
    },
    enqueue,
  }
}

/**
 * Run `body` with every `event` on `table` taking half a second to finish, so
 * the transaction that ran it commits that much later: a race decided by who
 * commits first, played the same way every time
 */
async function withSlowStatement(table: string, event: string, body: () => Promise<void>) {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION test_slow_statement() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NULL; END $$`)
  )
  await db.execute(
    sql.raw(`CREATE TRIGGER test_slow_statement AFTER ${event} ON "${table}"
    FOR EACH STATEMENT EXECUTE FUNCTION test_slow_statement()`)
  )
  try {
    await body()
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER test_slow_statement ON "${table}"`))
  }
}

beforeEach(async () => {
  await cleanDatabase()
})
afterAll(async () => {
  await closeTestDb()
})

describe('syncDueSearchDocs', () => {
  it('writes every marked document in one request and clears their marks', async () => {
    const a = await seed()
    const b = await seed()
    const { search, bulkIndexResources } = fakeSearch()

    expect(await syncDueSearchDocs(db, search)).toEqual({ synced: 2, refused: [] })

    expect(bulkIndexResources).toHaveBeenCalledOnce()
    expect(bulkIndexResources.mock.calls[0][0].map((d) => d.id).sort()).toEqual([a, b].sort())
    expect(await dueAt(a)).toBeNull()
    expect(await dueAt(b)).toBeNull()
  })

  it('writes nothing for a resource with no mark', async () => {
    await seed({ due: false })
    const { search, bulkIndexResources } = fakeSearch()

    expect(await syncDueSearchDocs(db, search)).toEqual({ synced: 0, refused: [] })
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

    await syncDueSearchDocs(db, search)

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

    expect(await syncDueSearchDocs(db, search)).toEqual({ synced: 2, refused: [] })

    expect(bulkIndexResources.mock.calls[0][0].map((d) => d.id)).toEqual([live])
    expect(deleteResources).toHaveBeenCalledWith([gone])
    expect(await dueAt(gone)).toBeNull()
  })

  it('removes the documents of a deleted dataset, whose resources the delete marked', async () => {
    // A writer that read them while the dataset was live may have written
    // them back after the delete took them
    const id = await seed({ packageState: 'deleted' })
    const { search, bulkIndexResources, deleteResources } = fakeSearch()

    await syncDueSearchDocs(db, search)

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

    await expect(syncDueSearchDocs(db, search)).rejects.toThrow('index unreachable')
    expect(await dueAt(live)).not.toBeNull()
    expect(await dueAt(gone)).not.toBeNull()
  })

  it("clears a draft's mark without writing, the index holding nothing of it until publish", async () => {
    // Left, the marks of drafts never published would pile up in front of
    // every batch
    const id = await seed({ packageState: 'draft' })
    const { search, bulkIndexResources, deleteResources } = fakeSearch()

    await syncDueSearchDocs(db, search)

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

    expect(await syncDueSearchDocs(db, search)).toEqual({
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

    await expect(syncDueSearchDocs(db, search)).rejects.toThrow('index unreachable')
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

    const sync = syncDueSearchDocs(db, search, { rowLockWaitMs: 200 })
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

    const sync = syncDueSearchDocs(db, search)
    await new Promise((r) => setTimeout(r, 100))
    expect(bulkIndexResources).not.toHaveBeenCalled()

    await release()
    expect(await sync).toEqual({ synced: 1, refused: [] })
    expect(await dueAt(id)).toBeNull()
  })
})

describe('writeMarkedResourceDocs', () => {
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
    expect(enqueue).toHaveBeenCalledWith('sync-search-docs', {}, { unlessWaiting: true })
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
    expect(enqueue).toHaveBeenCalledWith('sync-search-docs', {}, { unlessWaiting: true })
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

    const locked = drop((page) => withGlobalAdvisoryLock(db, SEARCH_DOC_SYNC_LOCK, page))
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
    expect(enqueue).toHaveBeenCalledWith('sync-search-docs', {}, { unlessWaiting: true })
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
      expect(await packageDueAt(packageId)).not.toBeNull()
    }
  )
})

/** A dataset of an organization, in one group, marked due unless `due: false` */
async function seedDatasetDoc(opts: { state?: string; due?: boolean } = {}) {
  const [org] = await db
    .insert(organization)
    .values({ name: `org-${crypto.randomUUID()}` })
    .returning({ id: organization.id, name: organization.name })
  const [grp] = await db
    .insert(group)
    .values({ name: `grp-${crypto.randomUUID()}` })
    .returning({ id: group.id, name: group.name })
  const [pkg] = await db
    .insert(packageTable)
    .values({
      name: `pkg-${crypto.randomUUID()}`,
      title: 'Station map',
      state: opts.state ?? 'active',
      ownerOrg: org.id,
      docSyncDueAt: opts.due === false ? null : sql`NOW() - interval '1 minute'`,
    })
    .returning({ id: packageTable.id })
  await db.insert(packageGroup).values({ packageId: pkg.id, groupId: grp.id })
  return { packageId: pkg.id, org, grp }
}

describe('dataset documents', () => {
  it('writes a marked live dataset with its organization and group names, and clears the mark', async () => {
    const { packageId, org, grp } = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()

    expect(await syncDueSearchDocs(db, search)).toEqual({ synced: 1, refused: [] })

    const [doc] = bulkIndexPackages.mock.calls.find(([docs]) => docs.length > 0)![0]
    expect(doc).toMatchObject({
      id: packageId,
      title: 'Station map',
      organization: org.name,
      groups: [grp.name],
    })
    expect(await packageDueAt(packageId)).toBeNull()
  })

  it("removes a deleted dataset's document, and only clears a draft's mark", async () => {
    // The index holds nothing of a draft until publish writes it (ADR-039)
    const deleted = await seedDatasetDoc({ state: 'deleted' })
    const draft = await seedDatasetDoc({ state: 'draft' })
    const { search, bulkIndexPackages, deletePackage } = fakeSearch()

    expect(await syncDueSearchDocs(db, search)).toEqual({ synced: 2, refused: [] })

    expect(deletePackage).toHaveBeenCalledOnce()
    expect(deletePackage).toHaveBeenCalledWith(deleted.packageId)
    expect(bulkIndexPackages.mock.calls.every(([docs]) => docs.length === 0)).toBe(true)
    expect(await packageDueAt(draft.packageId)).toBeNull()
  })

  it('keeps the mark of an edit that landed while its document was being written', async () => {
    // A delete in that window must not be dropped: the dataset would come
    // back into search with nothing left marked to take it out again
    const { packageId } = await seedDatasetDoc()
    let edited = false
    const { search } = fakeSearch(undefined, async () => {
      if (edited) return
      edited = true
      await db
        .update(packageTable)
        .set({ docSyncDueAt: sql`NOW()` })
        .where(eq(packageTable.id, packageId))
    })

    const first = await syncDueSearchDocs(db, search)

    // Written twice: the second batch read the newer mark and settled it
    expect(first.synced).toBe(1)
    expect(await packageDueAt(packageId)).toBeNull()
  })

  it('reports a document the index refuses, keeping its mark, and settles the rest', async () => {
    const bad = await seedDatasetDoc()
    const good = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()
    bulkIndexPackages.mockImplementation(async (docs: DatasetDoc[]) => {
      if (docs.some((d) => d.id === bad.packageId)) throw new BulkIndexError([bad.packageId])
    })

    const result = await syncDueSearchDocs(db, search)

    expect(result.refused).toEqual([bad.packageId])
    expect(await packageDueAt(bad.packageId)).not.toBeNull()
    expect(await packageDueAt(good.packageId)).toBeNull()
  })
})

describe('writeMarkedPackageDoc', () => {
  it("writes the dataset's document under the lock and asks for no job", async () => {
    const { packageId } = await seedDatasetDoc()
    const other = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()
    const { deps: d, enqueue } = deps(search)

    await writeMarkedPackageDoc(db, d, packageId)

    expect(bulkIndexPackages.mock.calls[0][0].map((doc) => doc.id)).toEqual([packageId])
    expect(await packageDueAt(packageId)).toBeNull()
    expect(await packageDueAt(other.packageId)).not.toBeNull()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('leaves the document to the job while a sync holds the lock', async () => {
    const { packageId } = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()
    const { deps: d, enqueue } = deps(search)
    const release = await holdDocSyncLock()

    await writeMarkedPackageDoc(db, d, packageId)

    expect(bulkIndexPackages).not.toHaveBeenCalled()
    expect(await packageDueAt(packageId)).not.toBeNull()
    expect(enqueue).toHaveBeenCalledWith('sync-search-docs', {}, { unlessWaiting: true })
    await release()
  })

  it('waits for the lock when the edit hides the dataset, and writes it itself', async () => {
    const { packageId } = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()
    const { deps: d, enqueue } = deps(search)
    const release = await holdDocSyncLock()

    const write = writeMarkedPackageDoc(db, d, packageId, { hides: true })
    // Still waiting while the sync holds the lock
    await new Promise((r) => setTimeout(r, 200))
    expect(bulkIndexPackages).not.toHaveBeenCalled()
    await release()
    await write

    expect(bulkIndexPackages.mock.calls[0][0].map((doc) => doc.id)).toEqual([packageId])
    expect(await packageDueAt(packageId)).toBeNull()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('lets one hiding edit wait at a time, and leaves the next to the job', async () => {
    const first = await seedDatasetDoc()
    const second = await seedDatasetDoc()
    const { search, bulkIndexPackages } = fakeSearch()
    const { deps: d, enqueue } = deps(search)
    const release = await holdDocSyncLockOffPool()

    const waiting = writeMarkedPackageDoc(db, d, first.packageId, { hides: true })
    // Answers at once, rather than take a second pooled connection to wait on
    await writeMarkedPackageDoc(db, d, second.packageId, { hides: true })
    expect(enqueue).toHaveBeenCalledWith('sync-search-docs', {}, { unlessWaiting: true })
    expect(await packageDueAt(second.packageId)).not.toBeNull()

    await release()
    await waiting
    expect(bulkIndexPackages.mock.calls.flat(2).map((doc) => doc.id)).toEqual([first.packageId])
  })
})

describe('what marks a dataset', () => {
  it.each([
    [
      'an edit',
      async (id: string) => {
        const pkg = await new PackageService(db).getByNameOrId(id)
        return new PackageService(db).update(id, {
          name: pkg.name,
          ownerOrg: pkg.ownerOrg!,
          title: 'Renamed',
        })
      },
    ],
    ['a delete', (id: string) => new PackageService(db).delete(id)],
  ] as const)('marks it in the transaction of %s', async (_, go) => {
    const { packageId } = await seedDatasetDoc({ due: false })

    await go(packageId)

    expect(await packageDueAt(packageId)).not.toBeNull()
  })

  it('marks the live datasets of a renamed organization, and not for other edits', async () => {
    const { packageId, org } = await seedDatasetDoc({ due: false })
    // A deleted one has no document to rewrite, and its removal is not repeated
    const [trashed] = await db
      .insert(packageTable)
      .values({ name: `pkg-${crypto.randomUUID()}`, state: 'deleted', ownerOrg: org.id })
      .returning({ id: packageTable.id })
    const service = new OrganizationService(db)

    await service.update(org.id, { name: org.name, title: 'New title', extras: {} })
    expect(await packageDueAt(packageId)).toBeNull()

    await service.update(org.id, { name: `${org.name}-renamed`, extras: {} })
    expect(await packageDueAt(packageId)).not.toBeNull()
    expect(await packageDueAt(trashed.id)).toBeNull()
  })

  it('marks the datasets of a renamed group, and those of a purged one', async () => {
    const renamed = await seedDatasetDoc({ due: false })
    const purged = await seedDatasetDoc({ due: false })
    const service = new GroupService(db)

    await service.update(renamed.grp.id, { name: `${renamed.grp.name}-renamed`, extras: {} })
    await service.delete(purged.grp.id)
    await service.purge(purged.grp.id)

    expect(await packageDueAt(renamed.packageId)).not.toBeNull()
    expect(await packageDueAt(purged.packageId)).not.toBeNull()
  })
})

describe('syncPackageMetadata', () => {
  const embedding = {
    getEmbeddingInfo: () => ({ model: 'test', dimensions: 3 }),
  } as unknown as AIAdapter

  it.each([
    ['asks for the vectors of a live dataset', 'active', true],
    ['asks for none of a draft, whose vectors publish builds (ADR-039)', 'draft', false],
  ] as const)('%s', async (_, state, asked) => {
    const { packageId } = await seedDatasetDoc({ state })
    await db.insert(resource).values({
      packageId,
      name: 'r.csv',
      state: 'active',
      embeddingDueAt: sql`NOW()`,
    })
    const { search } = fakeSearch()
    const { deps: d, enqueue } = deps(search, embedding)

    await syncPackageMetadata(db, d, packageId)

    const types = enqueue.mock.calls.map(([type]) => type)
    expect(types.includes('embed-resources')).toBe(asked)
    expect(await packageDueAt(packageId)).toBeNull()
  })
})

describe('under the sync lock', () => {
  it("takes its turn before a purge removes a dataset's documents", async () => {
    // A writer that read the dataset before its row went must not land after this
    const deletePackage = vi.fn(async (_id: string) => {})
    const release = await holdDocSyncLock()

    const purging = purgePackagesSearchDocs(db, ['pkg-gone'], {
      deletePackage,
    } as unknown as SearchAdapter)
    await new Promise((r) => setTimeout(r, 100))
    expect(deletePackage).not.toHaveBeenCalled()

    await release()
    await purging
    expect(deletePackage).toHaveBeenCalledWith('pkg-gone')
  })

  it("takes its turn before a rebuild writes a batch's dataset documents", async () => {
    await seedDatasetDoc({ due: false })
    const bulkIndexPackages = vi.fn(async () => {})
    const search = {
      bulkIndexPackages,
      bulkIndexResources: vi.fn(async () => {}),
      indexedDocumentIds: vi.fn(async () => []),
    } as unknown as SearchAdapter
    const release = await holdDocSyncLock()

    const rebuild = rebuildMetadataIndex(
      db,
      search,
      createLogger({ name: 'test', level: 'silent' })
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(bulkIndexPackages).not.toHaveBeenCalled()

    await release()
    await rebuild
    expect(bulkIndexPackages).toHaveBeenCalledOnce()
  })
})

describe('a group rename beside a dataset edit', () => {
  it('waits for the edit rather than deadlocking with it', async () => {
    // The edit holds its dataset's row while it relinks the group, which
    // checks its key to the group's row; the rename marks the dataset. With
    // the rename holding the group's full lock first, each waited on the other
    const { packageId, grp } = await seedDatasetDoc({ due: false })
    let relink!: () => void
    const relinked = new Promise<void>((r) => (relink = r))
    let editing!: () => void
    const isEditing = new Promise<void>((r) => (editing = r))
    const edit = db.transaction(async (tx) => {
      await tx.update(packageTable).set({ title: 'Edited' }).where(eq(packageTable.id, packageId))
      await tx.delete(packageGroup).where(eq(packageGroup.packageId, packageId))
      editing()
      await relinked
      await tx.insert(packageGroup).values({ packageId, groupId: grp.id })
    })
    await isEditing

    const rename = new GroupService(db).update(grp.id, {
      name: `${grp.name}-renamed`,
      extras: {},
    })
    await new Promise((r) => setTimeout(r, 100))
    relink()

    await expect(Promise.all([edit, rename])).resolves.toBeDefined()
    expect(await packageDueAt(packageId)).not.toBeNull()
  })
})

describe('a rename beside a publish', () => {
  it("leaves the published draft's document with the new name", async () => {
    // The rename skipped the draft; publishing it read the old name before the
    // rename committed and cleared its own mark, leaving nothing marked to
    // bring the new one in. Its rows are locked whatever their state, so the
    // publish waits for the rename and reads what it committed.
    const { packageId, org } = await seedDatasetDoc({ state: 'draft', due: false })
    await db.update(packageTable).set({ licenseId: 'cc-by' }).where(eq(packageTable.id, packageId))
    const renamedTo = `${org.name}-renamed`
    const release = await holdInTransaction(async (tx) => {
      await markPackageDocs(tx, eq(packageTable.ownerOrg, org.id))
      await tx.update(organization).set({ name: renamedTo }).where(eq(organization.id, org.id))
    })

    // The publish and the sync it runs, as the route does, while the rename is open
    const { search, bulkIndexPackages } = fakeSearch()
    const publishing = new PackageService(db)
      .publish(packageId)
      .then(() => writeMarkedPackageDoc(db, deps(search).deps, packageId))
    await new Promise((r) => setTimeout(r, 100))
    await release()
    await publishing

    // Written with the new name, or left marked for the job: either way the
    // index hears of the rename
    const written = bulkIndexPackages.mock.calls.flatMap(([docs]) => docs)
    const stale = written.some((d) => d.organization !== renamedTo)
    expect(stale && (await packageDueAt(packageId)) === null).toBe(false)
    expect(written.at(-1)?.organization ?? renamedTo).toBe(renamedTo)
  })
})

describe('a rename beside a dataset joining', () => {
  /** A live dataset joining `join`'s organization or group in a transaction held open */
  async function joining(join: (tx: Transaction, packageId: string) => Promise<unknown>) {
    const [pkg] = await db
      .insert(packageTable)
      .values({ name: `pkg-${crypto.randomUUID()}`, state: 'active' })
      .returning({ id: packageTable.id })
    return { packageId: pkg.id, release: await holdInTransaction((tx) => join(tx, pkg.id)) }
  }

  it.each([
    [
      'an organization',
      async () => {
        const { packageId, org } = await seedDatasetDoc({ due: false })
        return {
          name: org.name,
          join: (tx: Transaction, id: string) =>
            tx
              .update(packageTable)
              .set({ ownerOrg: org.id, docSyncDueAt: sql`NOW()` })
              .where(eq(packageTable.id, id)),
          rename: (to: string) =>
            new OrganizationService(db).update(org.id, { name: to, extras: {} }),
          field: (doc: DatasetDoc) => [doc.organization ?? ''],
          table: 'organization',
          packageId,
        }
      },
    ],
    [
      'a group',
      async () => {
        const { packageId, grp } = await seedDatasetDoc({ due: false })
        return {
          name: grp.name,
          join: async (tx: Transaction, id: string) => {
            await tx.insert(packageGroup).values({ packageId: id, groupId: grp.id })
            await tx
              .update(packageTable)
              .set({ docSyncDueAt: sql`NOW()` })
              .where(eq(packageTable.id, id))
          },
          rename: (to: string) => new GroupService(db).update(grp.id, { name: to, extras: {} }),
          field: (doc: DatasetDoc) => doc.groups ?? [],
          table: 'group',
          packageId,
        }
      },
    ],
  ])('marks a dataset that joins %s while it is renamed', async (_, seed) => {
    // The joining dataset commits after the rename looked for its datasets and
    // before it committed; its sync reads the old name, writes it and clears
    // its mark. The rename has to find it again, once it holds the row
    const { name, join, rename, field, table } = await seed()
    const { packageId, release } = await joining(join)
    const renamedTo = `${name}-renamed`
    const { search, bulkIndexPackages } = fakeSearch()

    // The rename commits half a second after its update, so the joining
    // dataset's sync always runs before it
    await withSlowStatement(table, 'UPDATE', async () => {
      const renaming = rename(renamedTo)
      await new Promise((r) => setTimeout(r, 100))
      await release()
      await new Promise((r) => setTimeout(r, 100))
      await writeMarkedPackageDoc(db, deps(search).deps, packageId)
      await renaming
    })

    // Whichever committed first: the last document written carries the new
    // name, or the dataset is left marked for the job to write it
    const last = bulkIndexPackages.mock.calls.flatMap(([docs]) => docs).at(-1)
    const stale = last !== undefined && !field(last).includes(renamedTo)
    expect(stale && (await packageDueAt(packageId)) === null).toBe(false)
  })
})

describe('a group purge beside a dataset joining it', () => {
  it('marks a dataset linked to the group while it was purged', async () => {
    // The link commits after the purge looked for the group's datasets and
    // before it deleted the group; the link's sync writes the name and clears
    // its mark, and the purge takes the link away with the group
    const { grp } = await seedDatasetDoc({ due: false })
    await db.update(group).set({ state: 'deleted' }).where(eq(group.id, grp.id))
    const [pkg] = await db
      .insert(packageTable)
      .values({ name: `pkg-${crypto.randomUUID()}`, state: 'active' })
      .returning({ id: packageTable.id })
    const release = await holdInTransaction(async (tx) => {
      await tx.insert(packageGroup).values({ packageId: pkg.id, groupId: grp.id })
      await tx
        .update(packageTable)
        .set({ docSyncDueAt: sql`NOW()` })
        .where(eq(packageTable.id, pkg.id))
    })

    const { search, bulkIndexPackages } = fakeSearch()

    // The purge commits half a second after its delete, so the link's sync
    // always runs before it
    await withSlowStatement('group', 'DELETE', async () => {
      const purging = new GroupService(db).purge(grp.id)
      await new Promise((r) => setTimeout(r, 100))
      await release()
      await new Promise((r) => setTimeout(r, 100))
      await writeMarkedPackageDoc(db, deps(search).deps, pkg.id)
      await purging
    })

    // Whichever committed first: the last document written no longer names
    // the group, or the dataset is left marked for the job to write it
    const last = bulkIndexPackages.mock.calls.flatMap(([docs]) => docs).at(-1)
    const stale = last?.groups?.includes(grp.name) ?? false
    expect(stale && (await packageDueAt(pkg.id)) === null).toBe(false)
  })
})
