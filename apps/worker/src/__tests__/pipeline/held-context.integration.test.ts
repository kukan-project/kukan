/**
 * Integration tests for the run-scoped context (ADR-044 §4).
 *
 * The invariant under test: a run that has been stopped does not go on writing
 * to the places outside the database. Those writes have no row to condition on
 * — a chunk in the search index, a version in the lake catalog — and a revert
 * deletes them before the run it stopped has necessarily noticed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { resource, resourcePipeline } from '@kukan/db'
import {
  CLAIM_STALE_AFTER_MS,
  cancelResourceRun,
  claimResources,
  type ResourceClaim,
} from '@kukan/api/services/pipeline-claim'
import { heldContext } from '../../pipeline/held-context'
import { RunCancelledError } from '../../pipeline/step-tracker'
import { createPipelineContextMock } from '../test-helpers/pipeline-context'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()

let resourceId: string
let claim: ResourceClaim

const doc = {
  resourceId: 'r',
  packageId: 'p',
  extractedText: 'x',
  contentType: 'tabular' as const,
  chunkIndex: 0,
  chunkSize: 1,
}

beforeEach(async () => {
  await cleanDatabase()
  const pkg = await db.execute(sql`
    INSERT INTO package (name, state) VALUES ('test-pkg-held-ctx', 'active') RETURNING id
  `)
  const packageId = (pkg.rows[0] as { id: string }).id
  const [res] = await db
    .insert(resource)
    .values({ packageId, name: 'r', urlType: 'upload' })
    .returning()
  resourceId = res.id
  await db.insert(resourcePipeline).values({ resourceId })
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

describe('heldContext', () => {
  it('passes the writes through while the run holds the resource', async () => {
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)

    await held.indexContent(doc)
    await held.deleteContent(resourceId)
    await held.ingestLakeVersion({ resourceId, version: 1, sourcePath: '/tmp/t.parquet' })

    expect(inner.indexContent).toHaveBeenCalledWith(doc)
    expect(inner.deleteContent).toHaveBeenCalledWith(resourceId)
    expect(inner.ingestLakeVersion).toHaveBeenCalled()
  })

  it('stops each of them once the run has been stopped', async () => {
    // The order that matters: a revert deletes the indexed content, and a run
    // still writing chunks would put the retracted content back.
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)
    await cancelResourceRun(db, resourceId)

    await expect(held.indexContent(doc)).rejects.toBeInstanceOf(RunCancelledError)
    await expect(held.deleteContent(resourceId)).rejects.toBeInstanceOf(RunCancelledError)
    await expect(
      held.ingestLakeVersion({ resourceId, version: 1, sourcePath: '/tmp/t.parquet' })
    ).rejects.toBeInstanceOf(RunCancelledError)

    expect(inner.indexContent).not.toHaveBeenCalled()
    expect(inner.deleteContent).not.toHaveBeenCalled()
    expect(inner.ingestLakeVersion).not.toHaveBeenCalled()
  })

  it('asks again for every chunk', async () => {
    // Asked once per step, a kill would leave the rest of a long file to be
    // indexed anyway. Per chunk, it stops at the next one.
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)

    await held.indexContent(doc)
    await cancelResourceRun(db, resourceId)

    await expect(held.indexContent(doc)).rejects.toBeInstanceOf(RunCancelledError)
    expect(inner.indexContent).toHaveBeenCalledTimes(1)
  })

  it('carries the claim into the pointer move rather than asking first', async () => {
    // The one write here that can hold its own condition. Asked about instead,
    // a stop arriving between the answer and the UPDATE would still let the
    // fetch publish (ADR-044 §4).
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)
    await cancelResourceRun(db, resourceId)

    const content = {
      key: 'resources/p/r/run',
      previousKey: null,
      hash: 'sha256:a',
      size: 1,
      previousHash: null,
    }
    await held.publishContent(resourceId, content)

    expect(inner.publishContent).toHaveBeenCalledWith(resourceId, { ...content, claim })
  })

  it('carries the claim into the version schema write', async () => {
    // The other write that can hold its own condition: the interpretation lands
    // on a row the resource keeps, so a displaced run must not reach it.
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)
    const opts = {
      resourceId,
      version: 1,
      schema: { rowCount: 0, columns: [] },
      noTableReason: 'no-columns' as const,
    }

    await held.recordVersionSchema(opts)

    expect(inner.recordVersionSchema).toHaveBeenCalledWith({ ...opts, claim })
  })

  it('leaves the rest of the context alone', async () => {
    // Reads and the writes that carry their own condition go through untouched;
    // this is not a second gate on everything.
    const inner = createPipelineContextMock()
    const held = heldContext(inner, claim, db)
    await cancelResourceRun(db, resourceId)

    await held.getResource(resourceId)

    expect(inner.getResource).toHaveBeenCalledWith(resourceId)
  })
})

// Keeps the shared mock honest: a context member added later is not silently
// left ungated because nothing looked.
it('wraps the writes a kill has to reach', () => {
  const inner = createPipelineContextMock()
  const held = heldContext(inner, claim, db)
  const wrapped = Object.keys(inner).filter(
    (k) => held[k as keyof typeof held] !== inner[k as keyof typeof inner]
  )

  expect(wrapped.sort()).toEqual([
    'deleteContent',
    'indexContent',
    'ingestLakeVersion',
    'publishContent',
    'recordVersionSchema',
  ])
  vi.clearAllMocks()
})
