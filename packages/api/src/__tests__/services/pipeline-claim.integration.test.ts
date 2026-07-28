/**
 * Integration tests for the per-resource execution claim (ADR-044).
 *
 * The invariant under test: one resource, one run — and a run that dies does
 * not hold the resource for good.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import {
  claimPipeline,
  pipelineClaimHolder,
  releasePipelineClaim,
} from '../../services/pipeline-claim'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

// The contract under test is the function's, not the deployment's: production
// reads its window from the worker's config, which every claimer shares.
const STALE_AFTER_MS = 15 * 60 * 1000
let resourceId: string
let pipelineId: string

async function pipelineRow() {
  const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
  return row
}

/** Age the claim, as a run that stalled right after taking it would. */
async function ageClaim(interval: string) {
  await db.execute(sql`
    UPDATE resource_pipeline SET claim_owner_at = NOW() - ${interval}::interval
    WHERE id = ${pipelineId}::uuid
  `)
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-claim', 'active') RETURNING id
  `)
  const packageId = (pkg.rows[0] as { id: string }).id
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

describe('claimPipeline', () => {
  it('gives the resource to one run and refuses the next', async () => {
    const first = await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)
    const second = await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)

    expect(first?.id).toBe(pipelineId)
    expect(second).toBeNull()
  })

  it('refuses a resource with no pipeline row', async () => {
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))

    expect(await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)).toBeNull()
  })

  it("clears the previous run's steps", async () => {
    const owner = randomUUID()
    await claimPipeline(db, resourceId, owner, STALE_AFTER_MS)
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId, stepName: 'fetch', status: 'complete' })
    await releasePipelineClaim(db, pipelineId, owner)

    await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)

    const steps = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, pipelineId))
    expect(steps).toHaveLength(0)
  })

  it('lets another run take a claim nothing has progressed', async () => {
    // A worker that died mid-run. Without this the resource would be stuck
    // until someone cleared it by hand — after every deploy, for every run in
    // flight.
    const dead = randomUUID()
    await claimPipeline(db, resourceId, dead, STALE_AFTER_MS)
    await ageClaim('1 hour')

    const taken = await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)

    expect(taken?.id).toBe(pipelineId)
    expect((await pipelineRow()).claimOwner).not.toBe(dead)
  })

  it('counts a step starting as progress, not just the pipeline row', async () => {
    // Only three call sites advance `updated`, so between the end of Extract
    // and the final write it does not move at all. A run in the middle of that
    // is working, and must not be taken from.
    await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)
    await ageClaim('1 hour')
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId, stepName: 'index', status: 'running', startedAt: sql`NOW()` })

    expect(await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)).toBeNull()
  })
})

describe('pipelineClaimHolder', () => {
  it('tells a held resource from one with no pipeline row', async () => {
    // A refused claim returns null for both, and only one of them is worth
    // coming back for.
    expect(await pipelineClaimHolder(db, resourceId)).toBe(false)

    await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)
    expect(await pipelineClaimHolder(db, resourceId)).toBe(true)

    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
    expect(await pipelineClaimHolder(db, resourceId)).toBe(false)
  })
})

describe('releasePipelineClaim', () => {
  it('frees the resource for the next run straight away', async () => {
    const owner = randomUUID()
    await claimPipeline(db, resourceId, owner, STALE_AFTER_MS)

    expect(await releasePipelineClaim(db, pipelineId, owner)).toBe(true)
    expect(await claimPipeline(db, resourceId, randomUUID(), STALE_AFTER_MS)).not.toBeNull()
  })

  it('will not let a displaced run release the claim that displaced it', async () => {
    // The reason the owner is recorded rather than inferred from `status`: this
    // run has been taken over and is still alive. Its final write must not hand
    // the resource to a third run while the second is working.
    const displaced = randomUUID()
    await claimPipeline(db, resourceId, displaced, STALE_AFTER_MS)
    await ageClaim('1 hour')
    const holder = randomUUID()
    await claimPipeline(db, resourceId, holder, STALE_AFTER_MS)

    expect(await releasePipelineClaim(db, pipelineId, displaced)).toBe(false)
    expect((await pipelineRow()).claimOwner).toBe(holder)
  })
})
