/**
 * Integration tests for the purge paths' execution claim (ADR-044 §1).
 *
 * The hole these close: Interpret writes its preview to storage before the
 * database hears of it, and version create copies the file before inserting
 * the row. A purge crossing either window sweeps the bucket, and the run then
 * writes the content back — with no row left that names it, no entry in
 * `orphaned_object`, and no sweep that looks there. A purge that ends with the
 * content still in the bucket.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { job, organization, resource, resourcePipeline, resourceVersion } from '@kukan/db'
import { PostgresQueueAdapter } from '@kukan/queue-adapter'
import { PURGE_ORG_JOB_TYPE } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { PackageService } from '../../services/package-service'
import { OrganizationService } from '../../services/organization-service'
import { CLAIM_STALE_AFTER_MS, claimResources } from '../../services/pipeline-claim'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'
import { queuedLakeDrops } from '../test-helpers/lake-drops'

const db = getTestDb()
const queue = new PostgresQueueAdapter({ db })

let orgId: string

/**
 * A storage adapter that records, each time it sweeps a prefix, whether any run
 * could still be writing to the objects it is deleting: either the resources
 * are claimed, or their pipeline rows are gone and nothing can claim them.
 */
function watchingStorage() {
  const duringSweep: { claimed: boolean; pipelineRows: number }[] = []
  const storage = {
    deleteByPrefix: vi.fn(async () => {
      const rows = await db.select().from(resourcePipeline)
      duringSweep.push({
        claimed: rows.some((r) => r.claimOwner !== null),
        pipelineRows: rows.length,
      })
    }),
    delete: vi.fn(),
  } as unknown as StorageAdapter
  return { storage, duringSweep }
}

async function addResource(packageId: string): Promise<string> {
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: `r-${randomUUID()}`, urlType: 'upload' })
    .returning()
  await db.insert(resourcePipeline).values({ resourceId: res.id })
  return res.id
}

/** A version of the resource that reached DuckLake, which names its table. */
async function ingest(resourceId: string) {
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    storageKey: `resources/${resourceId}/v1`,
    size: 1,
    hash: 'sha256:v1',
    origin: 'upload',
    ducklakeSnapshotId: 1,
  })
}

/** Take the resource, as a run in flight holds it. */
async function hold(resourceId: string) {
  await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
}

function createInput(name: string, state?: 'draft') {
  return {
    name,
    ownerOrg: orgId,
    private: false,
    type: 'dataset',
    extras: {},
    tags: [],
    groups: [],
    resources: [],
    ...(state ? { state } : {}),
  }
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const orgResult = await db.execute(sql`
    INSERT INTO organization (name, state) VALUES ('test-org-purge-claim', 'active') RETURNING id
  `)
  orgId = (orgResult.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('PackageService.purge', () => {
  it('defers while a run holds one of the package resources', async () => {
    const service = new PackageService(db)
    const pkg = await service.create(createInput('pkg-held'))
    await hold(await addResource(pkg.id))
    await service.delete(pkg.id)
    const { storage } = watchingStorage()

    await expect(service.purge(pkg.id, { storage, queue })).rejects.toThrow(/being processed/)
    expect(storage.deleteByPrefix).not.toHaveBeenCalled()

    // Still there for the retry — a half-done purge is the failure mode.
    expect(await service.getByNameOrId(pkg.id, 'deleted')).toBeTruthy()
  })

  it('sweeps only once nothing can take the resources any more', async () => {
    // This purge deletes the rows first, under the claim, and the claims go
    // with them — which is the point: from then on there is no pipeline row to
    // claim, so the sweep has nothing left to race.
    const service = new PackageService(db)
    const pkg = await service.create(createInput('pkg-free'))
    await addResource(pkg.id)
    await service.delete(pkg.id)
    const { storage, duringSweep } = watchingStorage()

    const purged = await service.purge(pkg.id, { storage, queue })

    expect(purged.id).toBe(pkg.id)
    expect(duringSweep).not.toHaveLength(0)
    expect(duringSweep.every((s) => s.pipelineRows === 0)).toBe(true)
  })

  it('leaves the DuckLake tables to the worker, queued with the rows', async () => {
    const service = new PackageService(db)
    const pkg = await service.create(createInput('pkg-lake'))
    const inLake = await addResource(pkg.id)
    await ingest(inLake)
    await addResource(pkg.id)
    await service.delete(pkg.id)

    await service.purge(pkg.id, { storage: watchingStorage().storage, queue })

    expect(await queuedLakeDrops()).toEqual([{ resourceIds: [inLake] }])
  })

  it('queues nothing when the purge is refused, or has no tables', async () => {
    const service = new PackageService(db)
    const held = await service.create(createInput('pkg-lake-held'))
    const resourceId = await addResource(held.id)
    await ingest(resourceId)
    await hold(resourceId)
    await service.delete(held.id)
    const plain = await service.create(createInput('pkg-plain'))
    await addResource(plain.id)
    await service.delete(plain.id)

    await expect(
      service.purge(held.id, { storage: watchingStorage().storage, queue })
    ).rejects.toThrow(/being processed/)
    await service.purge(plain.id, { storage: watchingStorage().storage, queue })

    expect(await queuedLakeDrops()).toEqual([])
  })
})

describe('PackageService.purgeDraft', () => {
  it('defers while a run holds one of the draft resources', async () => {
    const service = new PackageService(db)
    const draft = await service.createDraft({ ownerOrg: orgId }, TEST_USER_ID)
    await hold(await addResource(draft.id))
    const { storage } = watchingStorage()

    await expect(service.purgeDraft(draft.id, { storage, queue })).rejects.toThrow(
      /being processed/
    )

    expect(storage.deleteByPrefix).not.toHaveBeenCalled()
    // Left claimed for purge, which is how a re-run finishes it (ADR-039).
    expect((await service.getByNameOrId(draft.id, 'purging')).state).toBe('purging')
  })

  it('holds the resources across the storage sweep, not just the row delete', async () => {
    // This purge deletes the objects *before* the rows, so a claim that ended
    // at the row delete would leave the whole sweep unguarded.
    const service = new PackageService(db)
    const draft = await service.createDraft({ ownerOrg: orgId }, TEST_USER_ID)
    await addResource(draft.id)
    const { storage, duringSweep } = watchingStorage()

    await service.purgeDraft(draft.id, { storage, queue })

    expect(duringSweep).not.toHaveLength(0)
    expect(duringSweep.every((s) => s.claimed)).toBe(true)
  })

  it('leaves the DuckLake tables to the worker, queued with the rows', async () => {
    const service = new PackageService(db)
    const draft = await service.createDraft({ ownerOrg: orgId }, TEST_USER_ID)
    const resourceId = await addResource(draft.id)
    await ingest(resourceId)

    await service.purgeDraft(draft.id, { storage: watchingStorage().storage, queue })

    expect(await queuedLakeDrops()).toEqual([{ resourceIds: [resourceId] }])
  })
})

describe('OrganizationService.purgeDeletedOrg', () => {
  async function deletedOrgWithResource() {
    const pkgService = new PackageService(db)
    const pkg = await pkgService.create(createInput('pkg-org'))
    const resourceId = await addResource(pkg.id)
    await pkgService.delete(pkg.id)
    await db.execute(sql`UPDATE organization SET state = 'deleted' WHERE id = ${orgId}::uuid`)
    return { resourceId }
  }

  it('defers while a run holds one of the org resources', async () => {
    const { resourceId } = await deletedOrgWithResource()
    await hold(resourceId)
    const { storage } = watchingStorage()

    await expect(new OrganizationService(db).purgeDeletedOrg(orgId, { storage })).rejects.toThrow(
      /being processed/
    )

    expect(storage.deleteByPrefix).not.toHaveBeenCalled()
    // Left 'purging', which the job's redelivery already expects.
    const rows = await db.execute(sql`SELECT state FROM organization WHERE id = ${orgId}::uuid`)
    expect((rows.rows[0] as { state: string }).state).toBe('purging')
  })

  it('holds every resource across the erasure', async () => {
    await deletedOrgWithResource()
    const { storage, duringSweep } = watchingStorage()

    const result = await new OrganizationService(db).purgeDeletedOrg(orgId, { storage })

    expect(result.purged).toBe(true)
    expect(duringSweep).not.toHaveLength(0)
    expect(duringSweep.every((s) => s.claimed)).toBe(true)
  })
})

describe('OrganizationService.queueStrandedPurges', () => {
  it('queues the purge again once its job is gone, and not while one stands behind it', async () => {
    // Claimed by the job itself, so the purge route (which takes only a
    // 'deleted' organization) cannot ask again
    await db.update(organization).set({ state: 'purging' })
    const service = new OrganizationService(db)
    const queue = new PostgresQueueAdapter({ db })
    await queue.enqueue(PURGE_ORG_JOB_TYPE, { organizationId: orgId })

    expect(await service.queueStrandedPurges(queue)).toEqual({ queued: 0 })
    await db.update(job).set({ state: 'dead' })
    expect(await service.queueStrandedPurges(queue)).toEqual({ queued: 0 })

    await db.delete(job)
    expect(await service.queueStrandedPurges(queue)).toEqual({ queued: 1 })
    expect(await db.select({ payload: job.payload }).from(job)).toEqual([
      { payload: { organizationId: orgId } },
    ])
  })
})

describe('a resource with no pipeline row', () => {
  it('does not stop a purge', async () => {
    // Nothing can run against it either, so there is nothing to exclude.
    const service = new PackageService(db)
    const pkg = await service.create(createInput('pkg-unprocessed'))
    await db.insert(resource).values({ packageId: pkg.id, name: 'r', urlType: 'upload' })
    await service.delete(pkg.id)

    await expect(
      service.purge(pkg.id, { storage: watchingStorage().storage, queue })
    ).resolves.toBeTruthy()
  })
})
