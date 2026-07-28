/**
 * Integration tests for the purge paths' execution claim (ADR-044 §1).
 *
 * The hole these close: Extract writes its preview to storage before the
 * database hears of it, and version capture copies the file before inserting
 * the row. A purge crossing either window sweeps the bucket, and the run then
 * writes the content back — with no row left that names it, no entry in
 * `orphaned_object`, and no sweep that looks there. A legal deletion that ends
 * with the content still in the bucket.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline } from '@kukan/db'
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

const db = getTestDb()

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

/** Take the resource, as a run in flight holds it. */
async function hold(resourceId: string) {
  await claimResources(db, [resourceId], randomUUID(), CLAIM_STALE_AFTER_MS)
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

    await expect(service.purge(pkg.id, { storage })).rejects.toThrow(/being processed/)
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

    const purged = await service.purge(pkg.id, { storage })

    expect(purged.id).toBe(pkg.id)
    expect(duringSweep).not.toHaveLength(0)
    expect(duringSweep.every((s) => s.pipelineRows === 0)).toBe(true)
  })
})

describe('PackageService.purgeDraft', () => {
  it('defers while a run holds one of the draft resources', async () => {
    const service = new PackageService(db)
    const draft = await service.createDraft({ ownerOrg: orgId }, TEST_USER_ID)
    await hold(await addResource(draft.id))
    const { storage } = watchingStorage()

    await expect(service.purgeDraft(draft.id, { storage })).rejects.toThrow(/being processed/)

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

    await service.purgeDraft(draft.id, { storage })

    expect(duringSweep).not.toHaveLength(0)
    expect(duringSweep.every((s) => s.claimed)).toBe(true)
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

describe('a resource with no pipeline row', () => {
  it('does not stop a purge', async () => {
    // Nothing can run against it either, so there is nothing to exclude.
    const service = new PackageService(db)
    const pkg = await service.create(createInput('pkg-unprocessed'))
    await db.insert(resource).values({ packageId: pkg.id, name: 'r', urlType: 'upload' })
    await service.delete(pkg.id)

    await expect(
      service.purge(pkg.id, { storage: watchingStorage().storage })
    ).resolves.toBeTruthy()
  })
})
