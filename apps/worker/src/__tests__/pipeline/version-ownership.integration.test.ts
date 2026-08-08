/**
 * Integration tests for what a created version names (ADR-043 §1, ADR-046 §3).
 *
 * The invariant under test: a version owns the bytes it names. It takes an
 * object nothing else owns, and copies one that is already owned — because
 * purging a version deletes its file, and two versions sharing one file means
 * the purge either takes the other's content or leaves the content it was
 * asked to erase.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { claimResources, CLAIM_STALE_AFTER_MS } from '@kukan/api/services/pipeline-claim'
import { buildPipelineContext } from '../../pipeline/build-context'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

/** An upload's key: minted once, then reused by every run (ADR-043 §1). */
const LIVE_KEY = 'resources/pkg/res.upload-token'

let resourceId: string
let packageId: string

function fakeStorage() {
  const copied: [string, string][] = []
  const storage = {
    copy: vi.fn(async (from: string, to: string) => {
      copied.push([from, to])
    }),
  } as unknown as StorageAdapter
  return { storage, copied }
}

async function createVersionOnce(storage: StorageAdapter) {
  const owner = crypto.randomUUID()
  const { claimed } = await claimResources(db, [resourceId], owner, CLAIM_STALE_AFTER_MS, 'run')
  const ctx = buildPipelineContext(db, storage)
  const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
  return ctx.createVersion({
    resourceId,
    packageId,
    currentStorageKey: res.storageKey!,
    contentHash: res.hash!,
    contentSize: 1,
    claim: claimed[0],
  })
}

async function versionKeys(): Promise<string[]> {
  const rows = await db
    .select({ storageKey: resourceVersion.storageKey })
    .from(resourceVersion)
    .where(eq(resourceVersion.resourceId, resourceId))
    .orderBy(resourceVersion.version)
  return rows.map((r) => r.storageKey)
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-vown', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({
      packageId,
      name: 'r',
      urlType: 'upload',
      storageKey: LIVE_KEY,
      hash: 'sha256:same',
      format: 'CSV',
    })
    .returning()
  resourceId = res.id
  await db.insert(resourcePipeline).values({ resourceId })
})

afterAll(async () => {
  await closeTestDb()
})

describe('createVersion', () => {
  it('takes the live object when nothing else owns it', async () => {
    const { storage, copied } = fakeStorage()

    expect(await createVersionOnce(storage)).toEqual({ created: true, version: 1 })

    expect(copied).toEqual([])
    expect(await versionKeys()).toEqual([LIVE_KEY])
  })

  it('copies when the live object already belongs to a version', async () => {
    // Live does not move here: an upload keeps its key, so a format change
    // makes a version out of the very same file (ADR-046 §6). Filing it against
    // v1's object would put a purge of either one on the other's bytes.
    const { storage, copied } = fakeStorage()
    await createVersionOnce(storage)
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))

    expect(await createVersionOnce(storage)).toEqual({ created: true, version: 2 })

    const keys = await versionKeys()
    expect(keys[0]).toBe(LIVE_KEY)
    expect(keys[1]).not.toBe(LIVE_KEY)
    expect(copied).toEqual([[LIVE_KEY, keys[1]]])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('moves live onto the copy, so the newest version is what it names', async () => {
    // The purge decides what to delete from the live pointer. Left on v1's
    // object, purging v1 deletes what live is serving, and purging v2 deletes
    // v1's file on the way past — both directions lose canonical content.
    const { storage } = fakeStorage()
    await createVersionOnce(storage)
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))
    await createVersionOnce(storage)

    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    const keys = await versionKeys()
    expect(res.storageKey).toBe(keys[1])
    expect(res.storageKey).not.toBe(LIVE_KEY)
  })

  it('does not park the object the previous version kept', async () => {
    // The move parks whatever live steps off, and that is v1's own file now.
    const { storage } = fakeStorage()
    await createVersionOnce(storage)
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))
    await createVersionOnce(storage)

    const parked = await db.execute(sql`SELECT key FROM orphaned_object WHERE key = ${LIVE_KEY}`)
    expect(parked.rows).toEqual([])
  })

  it('records no version when the pointer cannot follow the copy', async () => {
    // The row and the pointer go together or not at all: a row that landed
    // while the pointer did not is the state that loses canonical content
    // whichever version is purged next.
    //
    // The move has to land between the insert and the publish, and both are
    // inside one transaction now — so it comes from a trigger, there being
    // nothing of ours in between to hook.
    const { storage } = fakeStorage()
    await createVersionOnce(storage)
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))
    await db.execute(sql`
      CREATE FUNCTION steal_pointer_mid_create() RETURNS trigger AS $$
      BEGIN
        UPDATE resource SET storage_key = 'resources/pkg/someone-elses'
        WHERE id = NEW.resource_id;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER steal_pointer_mid_create AFTER INSERT ON resource_version
      FOR EACH ROW EXECUTE FUNCTION steal_pointer_mid_create();
    `)

    try {
      expect(await createVersionOnce(storage)).toEqual({ created: false })
    } finally {
      await db.execute(sql`
        DROP TRIGGER steal_pointer_mid_create ON resource_version;
        DROP FUNCTION steal_pointer_mid_create();
      `)
    }

    // Rolled back with the transaction — including the trigger's own move.
    expect(await versionKeys()).toEqual([LIVE_KEY])
    const [res] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(res.storageKey).toBe(LIVE_KEY)
  })

  it('leaves the content itself unchanged, since only the reading of it moved', async () => {
    const { storage } = fakeStorage()
    await createVersionOnce(storage)
    const [before] = await db.select().from(resource).where(eq(resource.id, resourceId))
    await db.update(resource).set({ format: 'TSV' }).where(eq(resource.id, resourceId))
    await createVersionOnce(storage)

    const [after] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(after.hash).toBe(before.hash)
    expect(after.lastModified).toEqual(before.lastModified)
  })

  it('does not count a purged version as owning its old object', async () => {
    // A tombstone keeps its key because the column cannot be null, and the
    // object it named is already deleted — so it is not a reason to copy.
    const { storage, copied } = fakeStorage()
    await createVersionOnce(storage)
    await db
      .update(resourceVersion)
      .set({ state: 'purged' })
      .where(eq(resourceVersion.resourceId, resourceId))
    await db.update(resource).set({ hash: 'sha256:next' }).where(eq(resource.id, resourceId))

    expect(await createVersionOnce(storage)).toEqual({ created: true, version: 2 })

    expect(copied).toEqual([])
    expect((await versionKeys())[1]).toBe(LIVE_KEY)
  })
})
