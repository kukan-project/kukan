/**
 * Integration tests for the one-time version backfill (ADR-043): snapshot each
 * unversioned resource's live file as v1 without re-fetching/re-indexing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourceVersion } from '@kukan/db'
import { getStorageKey, getVersionKey } from '@kukan/shared'
import { ResourceVersionService } from '../../services/resource-version-service'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const service = new ResourceVersionService(db)

let packageId: string

async function addResource(opts: {
  name: string
  hash: string | null
  urlType?: string
  size?: number
}): Promise<string> {
  const [r] = await db
    .insert(resource)
    .values({
      packageId,
      name: opts.name,
      hash: opts.hash,
      size: opts.size ?? 10,
      urlType: opts.urlType ?? 'upload',
    })
    .returning()
  return r.id
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-backfill', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('countUnversioned', () => {
  it('counts active resources with content and no version', async () => {
    await addResource({ name: 'a', hash: 'sha256:a' })
    await addResource({ name: 'b', hash: 'sha256:b' })
    await addResource({ name: 'no-content', hash: null }) // never fetched → excluded

    expect(await service.countUnversioned()).toBe(2)
  })

  it('excludes resources that already have a version', async () => {
    const id = await addResource({ name: 'a', hash: 'sha256:a' })
    await db.insert(resourceVersion).values({
      resourceId: id,
      version: 1,
      storageKey: getVersionKey(packageId, id, 1),
      hash: 'sha256:a',
      origin: 'upload',
    })
    expect(await service.countUnversioned()).toBe(0)
  })
})

describe('backfillVersions', () => {
  it('snapshots the live key as v1 by server-side copy, no re-fetch', async () => {
    const uploadId = await addResource({ name: 'up', hash: 'sha256:u', urlType: 'upload' })
    const urlId = await addResource({ name: 'ext', hash: 'sha256:e', urlType: 'external' })
    const storage = { copy: vi.fn() } as never

    const result = await service.backfillVersions({ storage })

    expect(result).toEqual({ backfilled: 2, failed: 0 })
    // Copies from the live key to v1 — never a network fetch.
    expect((storage as { copy: ReturnType<typeof vi.fn> }).copy).toHaveBeenCalledWith(
      getStorageKey(packageId, uploadId),
      getVersionKey(packageId, uploadId, 1)
    )

    const upVer = await service.getVersion(uploadId, 1)
    expect(upVer.version).toBe(1)
    expect(upVer.origin).toBe('upload')
    const urlVer = await service.getVersion(urlId, 1)
    expect(urlVer.origin).toBe('fetch') // external URL → observed at fetch time

    // Nothing left to do.
    expect(await service.countUnversioned()).toBe(0)
  })

  it('is idempotent — a second run does nothing', async () => {
    await addResource({ name: 'a', hash: 'sha256:a' })
    const storage = { copy: vi.fn() } as never

    const first = await service.backfillVersions({ storage })
    expect(first.backfilled).toBe(1)
    const second = await service.backfillVersions({ storage })
    expect(second).toEqual({ backfilled: 0, failed: 0 })
  })

  it('counts a copy failure and keeps going', async () => {
    await addResource({ name: 'ok', hash: 'sha256:ok' })
    await addResource({ name: 'bad', hash: 'sha256:bad' })
    // Fail one copy, succeed the rest.
    const storage = {
      copy: vi.fn().mockRejectedValueOnce(new Error('missing object')).mockResolvedValue(undefined),
    } as never

    const result = await service.backfillVersions({ storage })
    expect(result.backfilled).toBe(1)
    expect(result.failed).toBe(1)
  })
})
