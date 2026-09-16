/**
 * Integration tests for the Summarize step (ADR-053).
 *
 * Three invariants that only a real row can show, each of which was broken
 * once: the step reads the artifacts of the run it is part of, an editor who
 * takes the abstract over mid-completion keeps it, and an input the provider
 * has already refused is not sent a second time.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { packageTable, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { AiInputRejectedError, type AIAdapter } from '@kukan/ai-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { createLogger } from '@kukan/shared'
import { setResourceSummary } from '@kukan/api/services/resource-summary-service'
import {
  executeSummarize,
  recordSkip,
  type SummaryDeps,
  type SummaryInput,
} from '../../pipeline/steps/summarize'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const MODEL = 'jp.anthropic.claude-sonnet-4-6'
const STORAGE_KEY = 'versions/pkg/res/v1'

// Mutable, so a test can change what the archive holds between two runs
let totalFiles = 2
const manifest = () =>
  JSON.stringify({
    totalFiles,
    entries: [
      { path: '令和七年度/集計表.csv', isDirectory: false },
      { path: '令和七年度/説明.txt', isDirectory: false },
    ],
  })

const storage = {
  download: async () => Readable.from([Buffer.from(manifest())]),
  downloadRange: async () => ({
    stream: Readable.from([
      Buffer.from(
        '令和七年度の統計資料である。区分ごとの件数と利用率を収録しており、前年度との比較も併せて掲載している。集計は三月末時点のものである。',
        'utf-8'
      ),
    ]),
  }),
} as unknown as StorageAdapter

function aiThat(complete: AIAdapter['complete']) {
  return {
    complete,
    getCompletionInfo: () => ({ provider: 'bedrock', defaultModel: MODEL, allowlist: [MODEL] }),
    getDocumentInfo: () => ({ documentFormats: ['pdf'], imageFormats: [], maxImageBytes: 1 }),
    getEmbeddingInfo: () => null,
  } as unknown as AIAdapter
}

const abstract = JSON.stringify({ summary: 'AI が書いた抄録。', groundedInMaterial: true })

function depsWith(ai: AIAdapter): SummaryDeps {
  return {
    db,
    storage,
    ai,
    model: MODEL,
    log: createLogger({ name: 'test', level: 'silent' }),
    locale: async () => 'ja',
  }
}

/** A published resource whose run is still in flight, as the step sees it */
async function seed(
  pipelineStatus: string,
  opts: { format?: string; failedStep?: string } = {}
): Promise<SummaryInput> {
  const format = opts.format ?? 'TXT'
  const [pkg] = await db
    .insert(packageTable)
    .values({
      name: `summarize-${pipelineStatus}-${format}-${Date.now()}`,
      state: 'active',
      private: false,
    })
    .returning({ id: packageTable.id })
  const [res] = await db
    .insert(resource)
    .values({
      packageId: pkg.id,
      name: '統計資料',
      format,
      size: 4096,
      state: 'active',
      storageKey: STORAGE_KEY,
    })
    .returning({ id: resource.id })
  const [pipeline] = await db
    .insert(resourcePipeline)
    .values({
      resourceId: res.id,
      status: pipelineStatus,
      previewKey: 'previews/manifest.json',
      metadata: { encoding: 'utf-8' },
    })
    .returning({ id: resourcePipeline.id })
  if (opts.failedStep) {
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId: pipeline.id, stepName: opts.failedStep, status: 'error' })
  }
  return {
    resourceId: res.id,
    packageId: pkg.id,
    version: 1,
    storageKey: STORAGE_KEY,
    format,
    size: 4096,
  }
}

async function storedSummary(id: string) {
  const [row] = await db
    .select({ summary: resource.summary, meta: resource.summaryMeta })
    .from(resource)
    .where(eq(resource.id, id))
  return row
}

beforeEach(async () => {
  totalFiles = 2
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('the Summarize step', () => {
  it('reads the artifacts of the run it is part of, which has not finished', async () => {
    // The row says `processing` because this step runs inside that run, before
    // the status is settled. Requiring `complete` here meant every table, text
    // file and archive recorded "no material" on every ordinary run — only the
    // formats whose original is sent got an abstract.
    const input = await seed('processing')

    const outcome = await executeSummarize(input, depsWith(aiThat(async () => abstract)))

    expect(outcome).toMatchObject({ status: 'written', material: 'text' })
    expect((await storedSummary(input.resourceId)).summary).toBe('AI が書いた抄録。')
  })

  it('will not take material from a preview the failed interpretation left behind', async () => {
    // The run that could not interpret the new version still finishes, so the
    // row reads `complete` with the *previous* version's preview on it. The run
    // is not what says whether the derivatives describe this content — the step
    // that writes them is.
    const input = await seed('complete', { format: 'ZIP', failedStep: 'interpret' })

    const outcome = await executeSummarize(input, depsWith(aiThat(async () => abstract)))

    expect(outcome).toEqual({ status: 'skipped', reason: 'no-material' })
  })

  it('takes the manifest when that interpretation did succeed', async () => {
    const input = await seed('complete', { format: 'ZIP' })

    const outcome = await executeSummarize(input, depsWith(aiThat(async () => abstract)))

    expect(outcome).toMatchObject({ status: 'written', material: 'files' })
  })

  it('leaves a run that failed outright alone', async () => {
    const input = await seed('error', { format: 'ZIP' })

    const outcome = await executeSummarize(input, depsWith(aiThat(async () => abstract)))

    expect(outcome).toEqual({ status: 'skipped', reason: 'no-material' })
  })

  it("keeps an editor's text when they take over while the provider is working", async () => {
    const input = await seed('processing')
    // The editor writes during the completion — the gates at the top of the
    // step read the row up to two minutes before this point.
    const ai = aiThat(async () => {
      await setResourceSummary(db, input.resourceId, { summary: '人が書いた説明。' })
      return abstract
    })

    const outcome = await executeSummarize(input, depsWith(ai))

    expect(outcome).toEqual({ status: 'unchanged' })
    const stored = await storedSummary(input.resourceId)
    expect(stored.summary).toBe('人が書いた説明。')
    expect(stored.meta.source).toBe('human')
  })

  it('keeps an abstract hidden when the editor hides it mid-completion', async () => {
    const input = await seed('processing')
    const ai = aiThat(async () => {
      await setResourceSummary(db, input.resourceId, { hidden: true })
      return abstract
    })

    const outcome = await executeSummarize(input, depsWith(ai))

    expect(outcome).toEqual({ status: 'unchanged' })
    const stored = await storedSummary(input.resourceId)
    expect(stored.meta.hidden).toBe(true)
    expect(stored.summary).toBeNull()
  })

  it('leaves an abstract alone while its version stands, whatever the pipeline derives now', async () => {
    // The derived material is not what the run compares: a listing that reads
    // one more file today, a column statistic Interpret started writing, a
    // settled version re-keyed — none of them are a change to the file, and
    // acting on them regenerated the catalogue unquoted. Reflecting a
    // better reading is a decision, taken by raising the generation.
    const input = await seed('complete', { format: 'ZIP' })
    const deps = depsWith(aiThat(async () => abstract))
    expect(await executeSummarize(input, deps)).toMatchObject({ status: 'written' })

    totalFiles = 3

    expect(await executeSummarize(input, deps)).toEqual({ status: 'unchanged' })
  })

  it('regenerates when the version moved', async () => {
    const input = await seed('complete', { format: 'ZIP' })
    const complete = vi.fn(async () => abstract)
    const deps = depsWith(aiThat(complete as unknown as AIAdapter['complete']))
    expect(await executeSummarize(input, deps)).toMatchObject({ status: 'written' })

    expect(await executeSummarize({ ...input, version: 2 }, deps)).toMatchObject({
      status: 'written',
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect((await storedSummary(input.resourceId)).meta.version).toBe(2)
  })

  it('leaves an abstract another generation wrote alone until a refresh asks', async () => {
    // Raising the generation makes every abstract in the catalogue stale at
    // once. An ordinary run must not act on that — a one-line edit would turn
    // every upload into a completion nobody chose.
    const input = await seed('processing')
    const complete = vi.fn(async () => abstract)
    const deps = depsWith(aiThat(complete as unknown as AIAdapter['complete']))
    await executeSummarize(input, deps)

    // The same material, written by a different model
    const elsewhere = { ...deps, model: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0' }

    expect(await executeSummarize(input, elsewhere)).toEqual({ status: 'unchanged' })
    expect(complete).toHaveBeenCalledTimes(1)

    // Asked for explicitly, it is rewritten
    expect(await executeSummarize({ ...input, refresh: true }, elsewhere)).toMatchObject({
      status: 'written',
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('costs nothing to ask for a refresh twice', async () => {
    const input = { ...(await seed('processing')), refresh: true }
    const complete = vi.fn(async () => abstract)
    const deps = depsWith(aiThat(complete as unknown as AIAdapter['complete']))

    await executeSummarize(input, deps)
    expect(await executeSummarize(input, deps)).toEqual({ status: 'unchanged' })

    // It compares rather than ignores, so the second press is free
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not pay twice for an input the provider has already refused', async () => {
    const input = await seed('processing')
    const complete = vi.fn(async () => {
      throw new AiInputRejectedError(
        'prompt is too long: 919286 tokens > 200000',
        'too-long',
        919286
      )
    })
    const deps = depsWith(aiThat(complete as unknown as AIAdapter['complete']))

    const first = await executeSummarize(input, deps)
    expect(first).toMatchObject({ status: 'skipped', reason: 'rejected', rejectedTokens: 919286 })
    // The caller records it, as the pipeline and the backfill both do
    if (first.status === 'skipped') await recordSkip(input, deps, first.reason, first)

    const second = await executeSummarize(input, deps)

    expect(second).toEqual({ status: 'unchanged' })
    // The second run recognised the refused input and never reached the provider
    expect(complete).toHaveBeenCalledTimes(1)
    const stored = await storedSummary(input.resourceId)
    expect(stored.meta.skipReason).toBe('rejected')
    expect(stored.meta.rejectedTokens).toBe(919286)
  })

  it('tries a refused input again once the version moved', async () => {
    // A refusal is about one version. The next version is a different file,
    // or the same bytes settled under a format of their own (migration 0029) —
    // either way the estimate quotes for it, so the run has to ask.
    const input = await seed('processing')
    const refusing = vi.fn(async () => {
      throw new AiInputRejectedError('prompt is too long: 919286 tokens', 'too-long', 919286)
    })
    const deps = depsWith(aiThat(refusing as unknown as AIAdapter['complete']))
    const first = await executeSummarize(input, deps)
    if (first.status === 'skipped') await recordSkip(input, deps, first.reason, first)
    expect((await storedSummary(input.resourceId)).meta.version).toBe(1)

    const next = await executeSummarize({ ...input, version: 2 }, deps)

    expect(next).toMatchObject({ status: 'skipped', reason: 'rejected', version: 2 })
    expect(refusing).toHaveBeenCalledTimes(2)
  })

  it('tries a refused file again on a model that might not refuse it', async () => {
    // A refusal is a fact about the input and the model that read it. A
    // deployment moving to a longer context has a file worth another attempt,
    // and the ordinary generation is where that happens — the estimate counts
    // it as work it will do.
    const input = await seed('processing')
    const refusing = vi.fn(async () => {
      throw new AiInputRejectedError(
        'prompt is too long: 919286 tokens > 200000',
        'too-long',
        919286
      )
    })
    const deps = depsWith(aiThat(refusing as unknown as AIAdapter['complete']))
    const first = await executeSummarize(input, deps)
    if (first.status === 'skipped') await recordSkip(input, deps, first.reason, first)

    // The same file, a model with room for it — and no refresh asked for
    const bigger = vi.fn(async () => abstract)
    const roomier = {
      ...depsWith(aiThat(bigger as unknown as AIAdapter['complete'])),
      model: 'jp.anthropic.claude-opus-4-8',
    }

    expect(await executeSummarize(input, roomier)).toMatchObject({ status: 'written' })
    expect(bigger).toHaveBeenCalledTimes(1)
  })
})
