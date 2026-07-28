/**
 * Integration tests for the per-resource execution claim (ADR-044).
 *
 * The invariant under test: one resource, one writer — a run that dies does not
 * hold the resource for good, and a job that touches many resources either gets
 * all of them or none.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import {
  CLAIM_STALE_AFTER_MS,
  claimResources,
  releaseResourceClaims,
  withResourceClaim,
  withResourceClaims,
} from '../../services/pipeline-claim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

// The contract under test is the function's, not the deployment's — but the two
// agree, since every claimer reads the same constant.
const STALE_AFTER_MS = CLAIM_STALE_AFTER_MS
let packageId: string
let resourceId: string
let pipelineId: string

async function pipelineRow(id = pipelineId) {
  const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, id))
  return row
}

/** A second resource of the same package, with a pipeline row of its own. */
async function addResource(): Promise<{ resourceId: string; pipelineId: string }> {
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: `r-${randomUUID()}`, urlType: 'upload' })
    .returning()
  const [pipe] = await db.insert(resourcePipeline).values({ resourceId: res.id }).returning()
  return { resourceId: res.id, pipelineId: pipe.id }
}

/** Age the claim, as a run that stalled right after taking it would. */
async function ageClaim(interval: string, id = pipelineId) {
  await db.execute(sql`
    UPDATE resource_pipeline SET claim_owner_at = NOW() - ${interval}::interval
    WHERE id = ${id}::uuid
  `)
}

/** Take the resource and keep it, as a run in flight does. */
async function hold(id = resourceId): Promise<string> {
  const owner = randomUUID()
  await claimResources(db, [id], owner, STALE_AFTER_MS)
  return owner
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-claim', 'active') RETURNING id
  `)
  packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
  const [pipe] = await db.insert(resourcePipeline).values({ resourceId }).returning()
  pipelineId = pipe.id
})

afterAll(async () => {
  await closeTestDb()
})

describe('claimResources', () => {
  it('gives the resource to one run and refuses the next', async () => {
    const first = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)
    const second = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)

    expect(first.claimed).toEqual([{ id: pipelineId, resourceId }])
    expect(second.claimed).toEqual([])
    expect(second.held).toEqual([{ id: pipelineId, resourceId }])
  })

  it('reports a resource with no pipeline row as neither taken nor held', async () => {
    // Nothing can run against it either, so there is nothing to exclude — the
    // difference between "busy" and "cannot run at all".
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))

    const result = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)

    expect(result).toEqual({ claimed: [], held: [] })
  })

  it('takes a whole set in one statement', async () => {
    // What makes a purge of hundreds of resources safe: no acquisition order to
    // agree on, and nothing that waits, so nothing to deadlock against.
    const second = await addResource()

    const result = await claimResources(
      db,
      [resourceId, second.resourceId],
      randomUUID(),
      STALE_AFTER_MS
    )

    expect(result.claimed.map((c) => c.id).sort()).toEqual([pipelineId, second.pipelineId].sort())
    expect(result.held).toEqual([])
  })

  it('takes what it can and reports the rest held', async () => {
    const second = await addResource()
    await hold(second.resourceId)

    const result = await claimResources(
      db,
      [resourceId, second.resourceId],
      randomUUID(),
      STALE_AFTER_MS
    )

    expect(result.claimed).toEqual([{ id: pipelineId, resourceId }])
    expect(result.held).toEqual([{ id: second.pipelineId, resourceId: second.resourceId }])
  })

  it('lets another run take a claim nothing has progressed', async () => {
    // A worker that died mid-run. Without this the resource would be stuck
    // until someone cleared it by hand — after every deploy, for every run in
    // flight.
    const dead = await hold()
    await ageClaim('1 hour')

    const taken = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)

    expect(taken.claimed).toEqual([{ id: pipelineId, resourceId }])
    expect((await pipelineRow()).claimOwner).not.toBe(dead)
  })

  it('counts a step starting as progress, not just the pipeline row', async () => {
    // Only three call sites advance `updated`, so between the end of Extract
    // and the final write it does not move at all. A run in the middle of that
    // is working, and must not be taken from.
    await hold()
    await ageClaim('1 hour')
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId, stepName: 'index', status: 'running', startedAt: sql`NOW()` })

    const result = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)

    expect(result.claimed).toEqual([])
    expect(result.held).toHaveLength(1)
  })

  it("leaves the row's own state alone", async () => {
    // Taking the resource is not the same as running it: a purge holds the
    // claim without ever pretending the pipeline is processing.
    await db
      .update(resourcePipeline)
      .set({ status: 'complete' })
      .where(eq(resourcePipeline.id, pipelineId))

    await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)

    expect((await pipelineRow()).status).toBe('complete')
  })
})

describe('releaseResourceClaims', () => {
  it('frees the resource for the next run straight away', async () => {
    const owner = await hold()

    expect(await releaseResourceClaims(db, [pipelineId], owner)).toBe(1)
    expect(
      (await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS)).claimed
    ).toHaveLength(1)
  })

  it('will not let a displaced run release the claim that displaced it', async () => {
    // The reason the owner is recorded rather than inferred from `status`: this
    // run has been taken over and is still alive. Its final write must not hand
    // the resource to a third run while the second is working.
    const displaced = await hold()
    await ageClaim('1 hour')
    const holder = await hold()

    expect(await releaseResourceClaims(db, [pipelineId], displaced)).toBe(0)
    expect((await pipelineRow()).claimOwner).toBe(holder)
  })
})

describe('withResourceClaim', () => {
  it('gives the claim back however the body ends', async () => {
    await withResourceClaim(db, resourceId, async () => undefined)
    expect((await pipelineRow()).claimOwner).toBeNull()

    await expect(
      withResourceClaim(db, resourceId, () => Promise.reject(new Error('step failed')))
    ).rejects.toThrow('step failed')
    expect((await pipelineRow()).claimOwner).toBeNull()
  })

  it('tells a held resource from one with no pipeline row', async () => {
    // Both refuse the run, and only one of them is worth coming back for.
    await hold()
    expect(await withResourceClaim(db, resourceId, async () => 'ran')).toMatchObject({
      status: 'held',
    })

    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
    expect(await withResourceClaim(db, resourceId, async () => 'ran')).toEqual({ status: 'absent' })
  })

  it('hands the body the row it claimed', async () => {
    const outcome = await withResourceClaim(db, resourceId, async (claim) => claim.id)

    expect(outcome).toEqual({ status: 'ran', result: pipelineId })
  })
})

describe('withResourceClaims', () => {
  it('runs for a set nothing is holding, and gives every claim back', async () => {
    const second = await addResource()
    let heldDuring: string[] = []

    const outcome = await withResourceClaims(db, [resourceId, second.resourceId], async () => {
      const rows = await db.select().from(resourcePipeline)
      heldDuring = rows.filter((r) => r.claimOwner !== null).map((r) => r.id)
      return 'purged'
    })

    expect(outcome).toEqual({ status: 'ran', result: 'purged' })
    expect(heldDuring.sort()).toEqual([pipelineId, second.pipelineId].sort())
    expect((await pipelineRow()).claimOwner).toBeNull()
    expect((await pipelineRow(second.pipelineId)).claimOwner).toBeNull()
  })

  it('refuses the whole set when one resource is held, and takes nothing', async () => {
    // Half a purge leaves exactly the objects the claim exists to prevent, so
    // the caller retries rather than proceeds — and the resources it did get
    // must not stay locked while it waits.
    const second = await addResource()
    await hold(second.resourceId)
    let ran = false

    const outcome = await withResourceClaims(db, [resourceId, second.resourceId], async () => {
      ran = true
    })

    // Named, so a purge that will not finish says which resource is blocking it.
    expect(outcome).toEqual({
      status: 'held',
      held: [{ id: second.pipelineId, resourceId: second.resourceId }],
    })
    expect(ran).toBe(false)
    expect((await pipelineRow()).claimOwner).toBeNull()
  })

  it('runs for resources that have no pipeline row', async () => {
    // A purge still has to erase a resource that was never processed.
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))

    expect(await withResourceClaims(db, [resourceId], async () => 'purged')).toEqual({
      status: 'ran',
      result: 'purged',
    })
  })

  it('gives the claims back when the body throws', async () => {
    await expect(
      withResourceClaims(db, [resourceId], () => Promise.reject(new Error('cleanup failed')))
    ).rejects.toThrow('cleanup failed')

    expect((await pipelineRow()).claimOwner).toBeNull()
  })
})
