/**
 * Integration tests for the step tracker's SQL (ADR-043, ADR-044, ADR-045).
 *
 * Every write here is a data-modifying CTE, which a mock cannot stand in for on
 * two counts: Postgres either parses the statement or does not, and what the
 * statement parks or releases is the whole point of it. The unit tests around
 * the orchestrator mock this class wholesale, so without these the statements
 * are never run at all.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import {
  CLAIM_STALE_AFTER_MS,
  claimResources,
  releaseResourceClaims,
  type ResourceClaim,
} from '@kukan/api/services/pipeline/pipeline-claim'
import { StepTracker, RunCancelledError } from '../../../pipeline/run/step-tracker'
import { getTestDb, cleanDatabase, closeTestDb } from '../../test-helpers/test-db'

const db = getTestDb()

const OLD_PREVIEW = 'previews/pkg/res/old.parquet'
const NEW_PREVIEW = 'previews/pkg/res/new.parquet'
const OLD_TEXT_HEAD = 'text-heads/pkg/res/old.txt'
const NEW_TEXT_HEAD = 'text-heads/pkg/res/new.txt'

let resourceId: string
let pipelineId: string
let claim: ResourceClaim

async function tracked(): Promise<string[]> {
  const rows = await db.execute(sql`SELECT key FROM orphaned_object ORDER BY key`)
  return (rows.rows as unknown as { key: string }[]).map((r) => r.key)
}

async function pipelineRow() {
  const [row] = await db.select().from(resourcePipeline).where(eq(resourcePipeline.id, pipelineId))
  return row
}

/** What a writer records before creating an object (ADR-045). */
async function reserve(key: string) {
  await db.execute(sql`
    INSERT INTO orphaned_object (key, expires_at) VALUES (${key}, NOW() + INTERVAL '1 hour')
  `)
}

/** The row as a previous run left it: a preview and a text head of its own. */
async function withPreviousRun() {
  await db
    .update(resourcePipeline)
    .set({ previewKey: OLD_PREVIEW, metadata: { textHeadKey: OLD_TEXT_HEAD } })
    .where(eq(resourcePipeline.id, pipelineId))
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-step-tracker', 'active') RETURNING id
  `)
  const packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
  const [pipe] = await db.insert(resourcePipeline).values({ resourceId }).returning()
  pipelineId = pipe.id
  const { claimed } = await claimResources(
    db,
    [resourceId],
    crypto.randomUUID(),
    CLAIM_STALE_AFTER_MS,
    'run'
  )
  claim = claimed[0]
})

afterAll(async () => {
  await closeTestDb()
})

describe('updateInterpretResult', () => {
  it('parks what it replaced and stops tracking the preview it now names', async () => {
    await withPreviousRun()
    await reserve(NEW_PREVIEW)

    await new StepTracker(db, claim).updateInterpretResult(NEW_PREVIEW, { encoding: 'UTF-8' }, null)

    const row = await pipelineRow()
    expect(row.previewKey).toBe(NEW_PREVIEW)
    expect(row.metadata).toEqual({ encoding: 'UTF-8' })
    // The text head goes with the metadata that named it: replaced wholesale,
    // so nothing else would ever park that object.
    expect(await tracked()).toEqual([OLD_PREVIEW, OLD_TEXT_HEAD])
  })

  it('parks the profile it replaced and stops tracking the one it now names (ADR-063)', async () => {
    const OLD_PROFILE = 'previews/pkg/res.old.profile.ndjson.zst'
    const NEW_PROFILE = 'previews/pkg/res.new.profile.ndjson.zst'
    await db
      .update(resourcePipeline)
      .set({ previewKey: OLD_PREVIEW, profile: { columns: [], key: OLD_PROFILE } })
      .where(eq(resourcePipeline.id, pipelineId))
    await reserve(NEW_PREVIEW)
    await reserve(NEW_PROFILE)

    await new StepTracker(db, claim).updateInterpretResult(
      NEW_PREVIEW,
      {},
      { columns: [], key: NEW_PROFILE }
    )

    expect((await pipelineRow()).profile).toEqual({ columns: [], key: NEW_PROFILE })
    expect((await tracked()).sort()).toEqual([OLD_PROFILE, OLD_PREVIEW].sort())
  })

  it('marks the search document when the table is read with other column names (ADR-063)', async () => {
    const schemaOf = (...names: string[]) => ({
      rowCount: 1,
      columns: names.map((name) => ({ name, type: 'string', nullable: false, nullCount: 0 })),
    })
    const dueAt = async () =>
      (await db.select().from(resource).where(eq(resource.id, resourceId)))[0].docSyncDueAt
    const tracker = new StepTracker(db, claim)

    await tracker.updateInterpretResult(NEW_PREVIEW, { schema: schemaOf('a') }, null)
    expect(await dueAt()).not.toBeNull()

    await db.update(resource).set({ docSyncDueAt: null }).where(eq(resource.id, resourceId))
    await tracker.updateInterpretResult(NEW_PREVIEW, { schema: schemaOf('a') }, null)
    // The same names: the document says what it said
    expect(await dueAt()).toBeNull()

    await tracker.updateInterpretResult(NEW_PREVIEW, { schema: schemaOf('a', 'b') }, null)
    expect(await dueAt()).not.toBeNull()
  })

  it('leaves the preview tracked when the run no longer holds the claim', async () => {
    await withPreviousRun()
    await reserve(NEW_PREVIEW)
    const tracker = new StepTracker(db, claim)
    await releaseResourceClaims(db, [claim.id], claim.owner)

    await tracker.updateInterpretResult(NEW_PREVIEW, { encoding: 'UTF-8' }, null)

    // Nothing came to reference the preview, so dropping its write-ahead record
    // would strand the object for good (ADR-045).
    expect(await tracked()).toEqual([NEW_PREVIEW])
    // The row still describes the run that holds it.
    expect((await pipelineRow()).previewKey).toBe(OLD_PREVIEW)
  })

  it('parks the previous preview when this run produced none', async () => {
    await withPreviousRun()

    await new StepTracker(db, claim).updateInterpretResult(null, {}, null)

    expect((await pipelineRow()).previewKey).toBeNull()
    expect(await tracked()).toEqual([OLD_PREVIEW, OLD_TEXT_HEAD])
  })
})

describe('mergeMetadata', () => {
  it('parks the text head it replaces and keeps the rest of the metadata', async () => {
    await withPreviousRun()
    await db
      .update(resourcePipeline)
      .set({ metadata: { encoding: 'UTF-8', textHeadKey: OLD_TEXT_HEAD } })
      .where(eq(resourcePipeline.id, pipelineId))
    await reserve(NEW_TEXT_HEAD)

    await new StepTracker(db, claim).mergeMetadata({
      contentIndexed: true,
      textHeadKey: NEW_TEXT_HEAD,
    })

    expect((await pipelineRow()).metadata).toEqual({
      encoding: 'UTF-8',
      contentIndexed: true,
      textHeadKey: NEW_TEXT_HEAD,
    })
    expect(await tracked()).toEqual([OLD_TEXT_HEAD])
  })

  it('parks the document text it replaces', async () => {
    const OLD_TEXT = 'previews/pkg/res.old.text.ndjson.zst'
    const NEW_TEXT = 'previews/pkg/res.new.text.ndjson.zst'
    await db
      .update(resourcePipeline)
      .set({ metadata: { documentTextKey: OLD_TEXT } })
      .where(eq(resourcePipeline.id, pipelineId))
    await reserve(NEW_TEXT)

    await new StepTracker(db, claim).mergeMetadata({ documentTextKey: NEW_TEXT })

    expect(await tracked()).toEqual([OLD_TEXT])
  })

  it('parks nothing when the merge names the text head already there', async () => {
    await db
      .update(resourcePipeline)
      .set({ metadata: { textHeadKey: NEW_TEXT_HEAD } })
      .where(eq(resourcePipeline.id, pipelineId))

    await new StepTracker(db, claim).mergeMetadata({ textHeadKey: NEW_TEXT_HEAD })

    expect(await tracked()).toEqual([])
  })

  it('writes nothing once the claim is gone', async () => {
    const tracker = new StepTracker(db, claim)
    await releaseResourceClaims(db, [claim.id], claim.owner)

    await tracker.mergeMetadata({ contentIndexed: true })

    expect((await pipelineRow()).metadata).toBeNull()
  })
})

describe('the run record', () => {
  it('clears the previous run steps and settles its own', async () => {
    const first = new StepTracker(db, claim)
    await first.beginRun()
    await first.completeStep(await first.startStep('fetch'))

    await first.beginRun()
    const stepId = await first.startStep('fetch')
    await first.failStep(stepId, 'boom')

    const steps = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, pipelineId))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ status: 'error', error: 'boom' })
    expect((await pipelineRow()).status).toBe('processing')
  })

  it('does not clear the steps of the run that displaced it', async () => {
    // A data-modifying CTE runs whether or not the primary statement matches,
    // so the delete has to hang off the update rather than stand beside it.
    const displaced = new StepTracker(db, claim)
    const { claimed } = await claimResources(db, [resourceId], crypto.randomUUID(), 0, 'run')
    const successor = new StepTracker(db, claimed[0])
    await successor.beginRun()
    await successor.startStep('fetch')

    await displaced.beginRun()

    const steps = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, pipelineId))
    expect(steps).toHaveLength(1)
  })

  it('records the step that was open when the run failed', async () => {
    // Fetch is the one step whose failure ends the run, so it is the one that
    // used to be abandoned mid-flight: the pipeline read `error` while its step
    // read `running`, and the UI shows the step.
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const stepId = await tracker.startStep('fetch')

    await tracker.failOpenStep('Resource has no uploaded file')

    const [step] = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.id, stepId))
    expect(step.status).toBe('error')
    expect(step.error).toBe('Resource has no uploaded file')
    expect(step.completedAt).not.toBeNull()
  })

  it('has nothing to record once the step settled itself', async () => {
    // The ordinary case: every step after Fetch catches its own failure and
    // closes its row, so the run-level handler must not reopen it.
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const stepId = await tracker.startStep('interpret')
    await tracker.completeStep(stepId)

    await tracker.failOpenStep('something later went wrong')

    const [step] = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.id, stepId))
    expect(step.status).toBe('complete')
    expect(step.error).toBeNull()
  })

  it('records a step still open underneath one that settled', async () => {
    // The Lake step is started from inside the interpretation, while Interpret
    // is still running. A single slot would be taken by Lake and cleared when
    // Lake settled, forgetting Interpret — so this only says anything with two
    // open at once. An earlier version of this test settled the first before
    // starting the second, which "remember the first" would also have passed.
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const outer = await tracker.startStep('interpret')
    const nested = await tracker.startStep('lake')
    await tracker.completeStep(nested)

    await tracker.failOpenStep('boom')

    const steps = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, claim.id))
    expect(steps.find((s) => s.id === nested)!.status).toBe('complete')
    expect(steps.find((s) => s.id === outer)!.status).toBe('error')
  })

  it('settles every step left open, innermost first', async () => {
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const outer = await tracker.startStep('interpret')
    const nested = await tracker.startStep('lake')

    await tracker.failOpenStep('boom')

    const steps = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, claim.id))
    expect(steps.map((s) => s.status).sort()).toEqual(['error', 'error'])
    expect(steps.find((s) => s.id === outer)!.error).toBe('boom')
    expect(steps.find((s) => s.id === nested)!.error).toBe('boom')
  })

  it('keeps a step open when settling it threw', async () => {
    // Clearing before the write would lose it here, and the run's handler would
    // then find nothing to record — `error` over a step reading `running`,
    // which is the state this whole mechanism exists to stop.
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const stepId = await tracker.startStep('fetch')

    let thrown = false
    const failing = {
      execute: (query: Parameters<typeof db.execute>[0]) => {
        if (!thrown) {
          thrown = true
          return Promise.reject(new Error('lock timeout'))
        }
        return db.execute(query)
      },
    } as unknown as typeof db
    const wobbly = new StepTracker(failing, claim)
    // Same claim, same pipeline — only the connection is unreliable.
    Object.assign(wobbly, { openSteps: [stepId] })
    await expect(wobbly.completeStep(stepId)).rejects.toThrow('lock timeout')

    await wobbly.failOpenStep('Download failed')

    const [step] = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.id, stepId))
    expect(step.status).toBe('error')
    expect(step.error).toBe('Download failed')
  })

  it('refuses to start a step once the claim is gone', async () => {
    const tracker = new StepTracker(db, claim)
    await releaseResourceClaims(db, [claim.id], claim.owner)

    await expect(tracker.startStep('interpret')).rejects.toBeInstanceOf(RunCancelledError)
  })

  it('cannot settle a step under a pipeline it no longer holds', async () => {
    const tracker = new StepTracker(db, claim)
    await tracker.beginRun()
    const stepId = await tracker.startStep('fetch')
    await releaseResourceClaims(db, [claim.id], claim.owner)

    await tracker.completeStep(stepId)

    // Left running: a killed run must not report the step it was cut off in as
    // done, which is what the resource page reads to say what survived.
    const [step] = await db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.id, stepId))
    expect(step.status).toBe('running')
  })
})

describe('the content index mark', () => {
  async function mark(): Promise<Date | null> {
    const [row] = await db
      .select({ dueAt: resource.contentIndexDueAt })
      .from(resource)
      .where(eq(resource.id, resourceId))
    return row.dueAt
  }

  it('raises it, and lowers the one it read', async () => {
    const tracker = new StepTracker(db, claim)
    expect(await tracker.contentIndexMark()).toBeNull()

    await tracker.raiseContentIndexMark()
    expect(await mark()).not.toBeNull()

    await tracker.lowerContentIndexMark(await tracker.contentIndexMark())
    expect(await mark()).toBeNull()
  })

  it('keeps a mark raised after the one it read', async () => {
    const tracker = new StepTracker(db, claim)
    await db
      .update(resource)
      .set({ contentIndexDueAt: sql`NOW() - INTERVAL '1 hour'` })
      .where(eq(resource.id, resourceId))
    const read = await tracker.contentIndexMark()
    // A delete while the step was writing
    await db
      .update(resource)
      .set({ contentIndexDueAt: sql`NOW()` })
      .where(eq(resource.id, resourceId))

    await tracker.lowerContentIndexMark(read)

    expect(await mark()).not.toBeNull()
  })

  it('leaves the mark of a resource deleted during the run to the sweep', async () => {
    const tracker = new StepTracker(db, claim)
    // The delete raises it; the Index step then finds no active row and skips
    await db
      .update(resource)
      .set({ state: 'deleted', contentIndexDueAt: sql`NOW()` })
      .where(eq(resource.id, resourceId))

    await tracker.lowerContentIndexMark(await tracker.contentIndexMark())

    expect(await mark()).not.toBeNull()
  })

  it('writes nothing once the claim is gone', async () => {
    const tracker = new StepTracker(db, claim)
    await tracker.raiseContentIndexMark()
    const read = await tracker.contentIndexMark()
    await releaseResourceClaims(db, [claim.id], claim.owner)

    await tracker.lowerContentIndexMark(read)
    expect(await mark()).not.toBeNull()

    await db.update(resource).set({ contentIndexDueAt: null }).where(eq(resource.id, resourceId))
    await tracker.raiseContentIndexMark()
    expect(await mark()).toBeNull()
  })
})
