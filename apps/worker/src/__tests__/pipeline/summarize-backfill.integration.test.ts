/**
 * Integration tests for the abstract backfill's walk (ADR-053 §11).
 *
 * The invariant: a generation somebody asked for covers every resource. The
 * chain retries its own transient failures through the queue, and a resource
 * another run is holding has to be waited for the same way — the run holding it
 * writes the abstract only if it reaches the step, which a failed Fetch or a
 * throttled provider means it does not.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { packageTable, resource, resourcePipeline, resourceVersion } from '@kukan/db'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { createLogger, SUMMARIZE_PACKAGE_JOB_TYPE, SYNC_RESOURCE_DOC_JOB_TYPE } from '@kukan/shared'
import { CLAIM_STALE_AFTER_MS, claimResources } from '@kukan/api/services/pipeline-claim'
import { summarizeNextInPackage } from '../../summary/backfill'
import type { SummaryDeps } from '../../pipeline/steps/summarize'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const MODEL = 'jp.anthropic.claude-sonnet-4-6'
const BODY =
  '令和七年度の統計資料である。区分ごとの件数と利用率を収録しており、前年度との比較も掲載している。集計は三月末時点のものであり、区分ごとの内訳を併記している。'

const storage = {
  download: async () => Readable.from([Buffer.from(BODY)]),
  downloadRange: async () => ({ stream: Readable.from([Buffer.from(BODY, 'utf-8')]) }),
} as unknown as StorageAdapter

const ai = {
  complete: async () => JSON.stringify({ summary: '抄録。', groundedInMaterial: true }),
  getCompletionInfo: () => ({ provider: 'bedrock', defaultModel: MODEL, allowlist: [MODEL] }),
  getDocumentInfo: () => null,
  // Available, so the walk's terminal embed is actually enqueued
  getEmbeddingInfo: () => ({ model: 'test-embed', dimensions: 4 }),
  embed: async () => [0, 0, 0, 0],
} as unknown as AIAdapter

const deps: SummaryDeps = {
  db,
  storage,
  ai,
  model: MODEL,
  log: createLogger({ name: 'test', level: 'silent' }),
  locale: async () => 'ja',
}

function fakeQueue() {
  const enqueue = vi.fn().mockResolvedValue('job')
  return { queue: { enqueue } as unknown as QueueAdapter, enqueue }
}

/** One published text resource with a version holding its current content */
async function seedPackage(): Promise<{ packageId: string; resourceId: string }> {
  const [pkg] = await db
    .insert(packageTable)
    .values({ name: `backfill-${Date.now()}`, state: 'active', private: false })
    .returning({ id: packageTable.id })
  const [res] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: '統計資料',
      format: 'TXT',
      size: 1024,
      state: 'active',
      hash: 'deadbeef',
      storageKey: 'versions/p/r/v1',
    })
    .returning({ id: resource.id })
  await db.insert(resourceVersion).values({
    resourceId: res.id,
    version: 1,
    storageKey: 'versions/p/r/v1',
    size: 1024,
    hash: 'deadbeef',
    origin: 'upload',
    // Deliberately unrecorded: versions created by the layer-1 backfill carry
    // no format, and reading that as "formatless" left the walk with no
    // material for six resources in seven
    format: null,
    state: 'active',
  })
  await db
    .insert(resourcePipeline)
    .values({ resourceId: res.id, status: 'complete', metadata: { encoding: 'utf-8' } })
  return { packageId: pkg.id, resourceId: res.id }
}

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('the backfill walk', () => {
  it('advances past a resource it has written', async () => {
    const { packageId, resourceId } = await seedPackage()
    const { queue, enqueue } = fakeQueue()

    const result = await summarizeNextInPackage(packageId, undefined, deps, queue)

    expect(result).toMatchObject({ done: false, resourceId, held: false })
    // Written, not merely walked past. The version carries no format — the
    // ordinary state for rows the layer-1 backfill created — and reading that
    // as "formatless" left six resources in seven with no material at all.
    const [row] = await db
      .select({ summary: resource.summary, meta: resource.summaryMeta })
      .from(resource)
      .where(eq(resource.id, resourceId))
    expect(row.summary).toBe('抄録。')
    expect(row.meta.material).toBe('text')
    expect(enqueue).toHaveBeenCalledWith(SUMMARIZE_PACKAGE_JOB_TYPE, {
      packageId,
      after: resourceId,
      refresh: false,
    })
    // The abstract is in the keyword leg as well as the vector, and this step
    // runs after Index — nothing else comes back to write the document. Queued
    // rather than written, so the retry belongs to the queue.
    expect(enqueue).toHaveBeenCalledWith(SYNC_RESOURCE_DOC_JOB_TYPE, { resourceId })
  })

  it('restates the document even when the abstract did not move', async () => {
    // Written and then failed to index, the retry finds the abstract unchanged
    // and would step past it for ever — the sentences left out of the index
    // with nothing left to notice. The document is a statement about the row,
    // so the walk restates it and repairs what a failed sync lost.
    const { packageId, resourceId } = await seedPackage()
    const { queue, enqueue } = fakeQueue()
    await summarizeNextInPackage(packageId, undefined, deps, queue)
    enqueue.mockClear()

    // Second pass over the same resource: nothing to generate
    await summarizeNextInPackage(packageId, undefined, deps, queue)

    expect(enqueue).toHaveBeenCalledWith(SYNC_RESOURCE_DOC_JOB_TYPE, { resourceId })
  })

  it('waits for a resource another run is holding instead of passing it over', async () => {
    const { packageId, resourceId } = await seedPackage()
    // A pipeline run has it. That run writes the abstract only if it reaches
    // the step — a failed Fetch never does — so the walk must come back rather
    // than drop the resource out of the generation somebody asked for.
    await claimResources(db, [resourceId], crypto.randomUUID(), CLAIM_STALE_AFTER_MS, 'run')
    const { queue, enqueue } = fakeQueue()

    const result = await summarizeNextInPackage(packageId, undefined, deps, queue)

    expect(result).toMatchObject({ held: true })
    // The same cursor, after a delay: the walk has not moved on
    expect(enqueue).toHaveBeenCalledWith(
      SUMMARIZE_PACKAGE_JOB_TYPE,
      { packageId, after: undefined, refresh: false },
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    )
  })

  it('enqueues the package embed once there is nothing left', async () => {
    const { packageId, resourceId } = await seedPackage()
    const { queue, enqueue } = fakeQueue()

    // The cursor the previous link left: this package's last resource
    const result = await summarizeNextInPackage(packageId, resourceId, deps, queue)

    expect(result).toEqual({ done: true })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][0]).not.toBe(SUMMARIZE_PACKAGE_JOB_TYPE)
  })
})
