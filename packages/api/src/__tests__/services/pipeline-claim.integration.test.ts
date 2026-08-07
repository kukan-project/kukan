/**
 * Integration tests for the per-resource execution claim (ADR-044).
 *
 * The invariant under test: one resource, one writer — a run that dies does not
 * hold the resource for good, and a job that touches many resources either gets
 * all of them or none.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { eq, sql } from 'drizzle-orm'
import { resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { inject } from 'vitest'
import { testDatabaseName, testDatabaseUrl } from '@kukan/db/testing'
import {
  CLAIM_STALE_AFTER_MS,
  cancelResourceRun,
  claimFromRun,
  claimResources,
  heldBy,
  releaseResourceClaims,
  stillHeld,
  withClaimFromRun,
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
  await claimResources(db, [id], owner, STALE_AFTER_MS, 'run')
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
    const owner = randomUUID()
    const first = await claimResources(db, [resourceId], owner, STALE_AFTER_MS, 'run')
    const second = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')

    // The owner comes back with the claim: the holder conditions its own writes
    // on it, which is what makes the run killable (ADR-044 §4).
    expect(first.claimed).toEqual([{ id: pipelineId, resourceId, owner }])
    expect(second.claimed).toEqual([])
    expect(second.held).toMatchObject([{ id: pipelineId, resourceId }])
    // Recorded on the row, because the kill is where the distinction has to be
    // made and by then the claimer is gone.
    expect((await pipelineRow()).claimKind).toBe('run')
  })

  it('gives the claim back along with the kind that took it', async () => {
    const owner = randomUUID()
    await claimResources(db, [resourceId], owner, STALE_AFTER_MS, 'job')
    expect((await pipelineRow()).claimKind).toBe('job')

    await releaseResourceClaims(db, [pipelineId], owner)

    expect((await pipelineRow()).claimKind).toBeNull()
  })

  it('mints a pipeline row for a resource that has none, and takes it', async () => {
    // Without this the caller got neither a claim nor a refusal and carried on
    // unexcluded (ADR-044 open issue 6).
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
    const owner = randomUUID()

    const result = await claimResources(db, [resourceId], owner, STALE_AFTER_MS, 'run')

    expect(result.held).toEqual([])
    expect(result.claimed).toMatchObject([{ resourceId, owner }])
  })

  it('reports a resource that is gone as neither taken nor held', async () => {
    // The row goes with it, and there is nothing left to exclude anyone from.
    await db.delete(resource).where(eq(resource.id, resourceId))

    const result = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')

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
      STALE_AFTER_MS,
      'run'
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
      STALE_AFTER_MS,
      'run'
    )

    expect(result.claimed).toMatchObject([{ id: pipelineId, resourceId }])
    expect(result.held).toMatchObject([{ id: second.pipelineId, resourceId: second.resourceId }])
  })

  it('lets another run take a claim nothing has progressed', async () => {
    // A worker that died mid-run. Without this the resource would be stuck
    // until someone cleared it by hand — after every deploy, for every run in
    // flight.
    const dead = await hold()
    await ageClaim('1 hour')

    const taken = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')

    expect(taken.claimed).toMatchObject([{ id: pipelineId, resourceId }])
    expect((await pipelineRow()).claimOwner).not.toBe(dead)
  })

  it('counts a step starting as progress, not just the pipeline row', async () => {
    // Only three call sites advance `updated`, so between the end of Interpret
    // and the final write it does not move at all. A run in the middle of that
    // is working, and must not be taken from.
    await hold()
    await ageClaim('1 hour')
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId, stepName: 'index', status: 'running', startedAt: sql`NOW()` })

    const result = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')

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

    await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')

    expect((await pipelineRow()).status).toBe('complete')
  })
})

describe('releaseResourceClaims', () => {
  it('frees the resource for the next run straight away', async () => {
    const owner = await hold()

    expect(await releaseResourceClaims(db, [pipelineId], owner)).toBe(1)
    expect(
      (await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')).claimed
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

  it('tells a held resource from one that is gone', async () => {
    // Both refuse the run, and only one of them is worth coming back for.
    await hold()
    expect(await withResourceClaim(db, resourceId, async () => 'ran')).toMatchObject({
      status: 'held',
    })

    await db.delete(resource).where(eq(resource.id, resourceId))
    expect(await withResourceClaim(db, resourceId, async () => 'ran')).toEqual({ status: 'absent' })
  })

  it('mints the row and runs when the resource never reached the pipeline', async () => {
    // The row is the claim, so a resource that was never enqueued used to be
    // refused outright — nothing to take, nothing to record the run against.
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))

    const outcome = await withResourceClaim(db, resourceId, async (claim) => claim.id)

    expect(outcome).toMatchObject({ status: 'ran' })
    const [minted] = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    // Left at the column default: nothing is queued and nothing has run.
    expect(minted.status).toBe('pending')
    expect(minted.claimOwner).toBeNull()
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
    expect(outcome).toMatchObject({
      status: 'held',
      held: [{ id: second.pipelineId, resourceId: second.resourceId }],
    })
    expect(ran).toBe(false)
    expect((await pipelineRow()).claimOwner).toBeNull()
  })

  it('holds a resource that has no pipeline row instead of running beside it', async () => {
    // The gap this closes (ADR-044 open issue 6): a purge over a resource that
    // was never processed took no claim and ran anyway, so a run arriving in
    // the middle of it wrote the derivatives back after the sweep had passed.
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
    let refusedDuring: Awaited<ReturnType<typeof claimResources>> | undefined

    const outcome = await withResourceClaims(db, [resourceId], async () => {
      refusedDuring = await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'run')
      return 'purged'
    })

    expect(outcome).toEqual({ status: 'ran', result: 'purged' })
    expect(refusedDuring?.claimed).toEqual([])
    expect(refusedDuring?.held).toMatchObject([{ resourceId }])
  })

  it('takes back the row it minted when the set is refused', async () => {
    // The mint happens inside the same transaction as the take, so a refusal
    // leaves nothing behind — not even for a resource it had to create a row
    // for. Otherwise a purge that never retries would strand a pending row.
    const second = await addResource()
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
    await hold(second.resourceId)

    const outcome = await withResourceClaims(db, [resourceId, second.resourceId], async () => {})

    expect(outcome).toMatchObject({ status: 'held' })
    const rows = await db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
    expect(rows).toEqual([])
  })

  it('leaves out an id whose resource is gone rather than failing the set', async () => {
    // A purge names what it read a moment ago, and rows do disappear in
    // between. The foreign key would take the whole set down with it.
    const second = await addResource()
    await db.delete(resource).where(eq(resource.id, second.resourceId))

    const outcome = await withResourceClaims(db, [resourceId, second.resourceId], async (claims) =>
      claims.map((c) => c.resourceId)
    )

    expect(outcome).toEqual({ status: 'ran', result: [resourceId] })
  })

  it('gives the claims back when the body throws', async () => {
    await expect(
      withResourceClaims(db, [resourceId], () => Promise.reject(new Error('cleanup failed')))
    ).rejects.toThrow('cleanup failed')

    expect((await pipelineRow()).claimOwner).toBeNull()
  })
})

describe('cancelResourceRun', () => {
  it('takes the resource back and records that the run was stopped', async () => {
    await hold()

    expect(await cancelResourceRun(db, resourceId)).toBe(true)

    const row = await pipelineRow()
    expect(row.claimOwner).toBeNull()
    // Not `error` — nothing failed. The run was stopped on purpose, and the
    // resource is left holding content no derivative describes (ADR-044 §4).
    expect(row.status).toBe('cancelled')
  })

  it('reports that there was nothing to stop', async () => {
    // A resource whose run already finished. Saying otherwise would have the
    // caller believe it interrupted work that was already done.
    expect(await cancelResourceRun(db, resourceId)).toBe(false)
  })

  it('leaves the content alone', async () => {
    // Reverting is a separate decision (§4): someone stopping a stuck run does
    // not want their content moved out from under them.
    await db
      .update(resource)
      .set({ storageKey: 'resources/pkg/live', hash: 'sha256:x' })
      .where(eq(resource.id, resourceId))
    await hold()

    await cancelResourceRun(db, resourceId)

    const [row] = await db.select().from(resource).where(eq(resource.id, resourceId))
    expect(row.storageKey).toBe('resources/pkg/live')
    expect(row.hash).toBe('sha256:x')
  })

  it('leaves a job holding the resource alone', async () => {
    // A purge or a backfill has no per-write ownership check to fail, so
    // releasing its claim would not stop it — it would only let a run start
    // alongside the work the claim exists to keep runs away from.
    const owner = randomUUID()
    await claimResources(db, [resourceId], owner, STALE_AFTER_MS, 'job')

    expect(await cancelResourceRun(db, resourceId)).toBe(false)

    const row = await pipelineRow()
    expect(row.claimOwner).toBe(owner)
    expect(row.status).not.toBe('cancelled')
  })
})

describe('claimFromRun', () => {
  it('stops the run and holds the resource in the same statement', async () => {
    await hold()

    const outcome = await claimFromRun(db, resourceId)

    expect(outcome).toMatchObject({ status: 'claimed', cancelled: true })
    const row = await pipelineRow()
    expect(row.status).toBe('cancelled')
    // Never free in between: a job already waiting would otherwise take the
    // resource and write over the very content being retracted.
    expect(row.claimOwner).not.toBeNull()
    expect(row.claimKind).toBe('job')
  })

  it('holds an idle resource without calling it cancelled', async () => {
    const outcome = await claimFromRun(db, resourceId)

    expect(outcome).toMatchObject({ status: 'claimed', cancelled: false })
    // Nothing was stopped, so nothing is recorded as stopped.
    expect((await pipelineRow()).status).not.toBe('cancelled')
  })

  it('refuses a resource a job is already working on', async () => {
    await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'job')

    expect(await claimFromRun(db, resourceId)).toMatchObject({ status: 'held' })
  })

  it('takes a job claim nothing has progressed under', async () => {
    // The same recovery every claimer gets: a purge whose worker died must not
    // hold the resource against a revert for good.
    await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'job')
    await ageClaim(`${STALE_AFTER_MS * 2} milliseconds`)

    expect(await claimFromRun(db, resourceId)).toMatchObject({ status: 'claimed' })
  })

  it('mints the row for a resource that has none, so the revert runs held', async () => {
    // The revert used to create this row itself, being the only caller that had
    // noticed it had to (ADR-044 open issue 6).
    await db.delete(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))

    const takeover = await claimFromRun(db, resourceId)

    expect(takeover).toMatchObject({ status: 'claimed', cancelled: false })
    expect(takeover).not.toMatchObject({ claim: null })
  })

  it('has nothing to hold for a resource that is gone', async () => {
    // Not a refusal: nothing could have been running, so the caller carries on
    // rather than coming back — with no claim, because there is nothing to hold.
    await db.delete(resource).where(eq(resource.id, resourceId))

    expect(await claimFromRun(db, resourceId)).toEqual({
      status: 'claimed',
      claim: null,
      cancelled: false,
    })
  })
})

describe('withClaimFromRun', () => {
  it('gives the claim back however the work ends', async () => {
    await hold()

    await expect(
      withClaimFromRun(db, resourceId, 'revert', async () => {
        throw new Error('revert failed')
      })
    ).rejects.toThrow('revert failed')

    // Held on the way out, the resource would be closed to every run and every
    // other revert until it went stale.
    expect((await pipelineRow()).claimOwner).toBeNull()
  })

  it('refuses rather than running alongside a job', async () => {
    await claimResources(db, [resourceId], randomUUID(), STALE_AFTER_MS, 'job')
    const ran = vi.fn()

    await expect(withClaimFromRun(db, resourceId, 'revert', ran)).rejects.toThrow(
      /being processed; retry the revert/
    )
    expect(ran).not.toHaveBeenCalled()
  })
})

describe('heldBy', () => {
  // The condition every write a run makes carries. It is what turns releasing
  // the claim into a kill: the run's next statement matches nothing.
  async function writeAsRun(claim: { id: string; resourceId: string; owner: string }) {
    const result = await db.execute(sql`
      UPDATE resource_pipeline SET status = 'processing' WHERE ${heldBy(claim)} RETURNING id
    `)
    return result.rows.length
  }

  it('matches while the run holds the resource, and stops once it does not', async () => {
    const owner = await hold()
    const claim = { id: pipelineId, resourceId, owner }

    expect(await writeAsRun(claim)).toBe(1)

    await cancelResourceRun(db, resourceId)

    expect(await writeAsRun(claim)).toBe(0)
  })

  it('stops matching for a run that was taken over', async () => {
    // The stale-takeover path reaches the same place as a kill: the displaced
    // run is still alive, and its writes must not land on the row the run that
    // displaced it now owns.
    const displaced = await hold()
    await ageClaim('1 hour')
    await hold()

    expect(await writeAsRun({ id: pipelineId, resourceId, owner: displaced })).toBe(0)
  })
})

describe('stillHeld — ordering against the cancel', () => {
  // The condition the three writes that outlive a run carry (the version row,
  // the live pointer, the deferred-ingest pointer). `heldBy` above is checked
  // against a claim that is already gone; what is checked here is the harder
  // case — a write in flight when the cancel arrives.
  //
  // A second connection is needed because the scenario is three sessions: one
  // holding the writer's target row, the writer waiting on it, and the cancel.
  // The pool cannot supply the first, since a transaction left open on a pooled
  // client would be handed to something else.
  let blocker: Client

  beforeEach(async () => {
    blocker = new Client({
      connectionString: testDatabaseUrl(testDatabaseName(inject('testDbPrefix'))),
    })
    await blocker.connect()
  })

  afterEach(async () => {
    await blocker.end()
  })

  /** A write conditioned on the claim, of the shape all three writers use. */
  const writeAsRun = (claim: { id: string; owner: string }) =>
    db.execute(sql`
      UPDATE resource SET size = 99 WHERE id = ${resourceId}::uuid AND ${stillHeld(claim as never)}
      RETURNING id
    `)

  it('finishes the write before the cancel it raced, not after', async () => {
    // Without the lock the writer reads the claim from a snapshot taken before
    // the cancel, waits on the row it is updating, and then lands anyway — so
    // `cancelResourceRun` returns having stopped a run that goes on writing.
    const owner = await hold()
    const claim = { id: pipelineId, owner }
    const order: string[] = []

    // Something else holds the row the write is aimed at — an upload promoting,
    // a purge restoring — so the write has to wait, as it would in production.
    await blocker.query('BEGIN')
    await blocker.query(`UPDATE resource SET size = 1 WHERE id = $1`, [resourceId])

    const written = writeAsRun(claim).then((r) => {
      order.push('write')
      return r.rows.length
    })
    await settle()
    const cancelled = cancelResourceRun(db, resourceId).then((c) => {
      order.push('cancel')
      return c
    })
    await settle()

    await blocker.query('COMMIT')
    const [rows, stopped] = await Promise.all([written, cancelled])

    expect(stopped).toBe(true)
    expect(order).toEqual(['write', 'cancel'])
    // It wrote, and that is correct: it got there first. What must not happen is
    // the other order — a cancel that has already returned, then a write.
    expect(rows).toBe(1)
  })

  it('refuses once the cancel has settled', async () => {
    const owner = await hold()
    await cancelResourceRun(db, resourceId)

    expect((await writeAsRun({ id: pipelineId, owner })).rows.length).toBe(0)
  })
})

/** Long enough for a blocked statement to have reached the lock it waits on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))
