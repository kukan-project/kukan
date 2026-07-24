/**
 * Integration tests for ResourceVersionService purge flow (ADR-043, layer 1).
 * Exercises claim (active → purging) and worker execution (file deletion,
 * rollback of the live version, tombstone) against real PostgreSQL.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { getStorageKey, getVersionKey } from '@kukan/shared'
import { ResourceVersionService } from '../../services/resource-version-service'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  TEST_USER_ID,
} from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string
let resourceId: string
const userId = TEST_USER_ID

function mockDeps() {
  return {
    storage: { copy: vi.fn(), delete: vi.fn() } as never,
    search: { deleteContent: vi.fn() } as never,
    queue: { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
  }
}

async function addVersion(version: number, hash: string, state = 'active') {
  await db.insert(resourceVersion).values({
    resourceId,
    version,
    storageKey: getVersionKey(packageId, resourceId, version),
    size: 100 + version,
    hash,
    origin: 'upload',
    state,
  })
}

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-versions', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const res = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload', hash: 'sha256:v2', size: 102 })
    .returning()
  resourceId = res[0].id
})

afterAll(async () => {
  await closeTestDb()
})

describe('claimPurge', () => {
  it('transitions active → purging and records who/why', async () => {
    await addVersion(1, 'sha256:v1')
    const { claimed, view } = await service.claimPurge(resourceId, 1, userId, 'contains PII')

    expect(claimed).toBe(true)
    expect(view.state).toBe('purging')
    const [row] = await db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, 1)))
    expect(row.state).toBe('purging')
    expect(row.purgedBy).toBe(userId)
    expect(row.purgeReason).toBe('contains PII')
  })

  it('is idempotent — a non-active version is not re-claimed', async () => {
    await addVersion(1, 'sha256:v1', 'purging')
    const { claimed } = await service.claimPurge(resourceId, 1, userId, 'again')
    expect(claimed).toBe(false)
  })
})

describe('executePurge', () => {
  it('rolls the live version back to the previous one', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2') // live (matches resource.hash)
    await service.claimPurge(resourceId, 2, userId, 'illegal content')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 2, deps)

    expect(result).toEqual({ purged: true, rolledBack: true })
    // v2's versioned copy deleted.
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 2))
    // v1 restored to the current key.
    expect(deps.storage.copy).toHaveBeenCalledWith(
      getVersionKey(packageId, resourceId, 1),
      getStorageKey(packageId, resourceId)
    )
    // Pipeline re-enqueued to regenerate derivatives.
    expect(deps.queue.enqueue).toHaveBeenCalled()

    // resource hash rolled back to v1.
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v1')

    // v2 is a purged tombstone; content fields withheld via the view.
    const view = await service.getVersion(resourceId, 2)
    expect(view.state).toBe('purged')
    expect(view.hash).toBeNull()
  })

  it('empties the resource when no previous active version remains', async () => {
    await addVersion(1, 'sha256:v2') // only version, live
    await db.update(resource).set({ hash: 'sha256:v2' }).where(eq(resource.id, resourceId))
    await service.claimPurge(resourceId, 1, userId, 'illegal')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)

    expect(result).toEqual({ purged: true, rolledBack: false })
    // Current key deleted (nothing to roll back to).
    expect(deps.storage.delete).toHaveBeenCalledWith(getStorageKey(packageId, resourceId))
    expect(deps.queue.enqueue).not.toHaveBeenCalled()

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBeNull()
  })

  it('purging a historical (non-live) version leaves the current key intact', async () => {
    await addVersion(1, 'sha256:v1')
    await addVersion(2, 'sha256:v2') // live
    await service.claimPurge(resourceId, 1, userId, 'old mistake')

    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)

    expect(result).toEqual({ purged: true, rolledBack: false })
    expect(deps.storage.delete).toHaveBeenCalledWith(getVersionKey(packageId, resourceId, 1))
    // No rollback / current-key touch for a non-live version.
    expect(deps.storage.copy).not.toHaveBeenCalled()
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.hash).toBe('sha256:v2')
  })

  it('is idempotent — a version not in purging state is a no-op', async () => {
    await addVersion(1, 'sha256:v1')
    const deps = mockDeps()
    const result = await service.executePurge(resourceId, 1, deps)
    expect(result).toEqual({ purged: false, rolledBack: false })
    expect(deps.storage.delete).not.toHaveBeenCalled()
  })
})
