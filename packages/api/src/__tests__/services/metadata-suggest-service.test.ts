import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { createLogger } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { createMockDb } from '../test-helpers/mock-db'
import {
  MetadataSuggestService,
  type SuggestPackageDetail,
} from '../../services/metadata-suggest-service'

const mockQuery = vi.fn()
vi.mock('../../services/query-service', () => ({
  QueryService: vi.fn().mockImplementation(function () {
    return { query: mockQuery }
  }),
}))

const silentLogger = createLogger({ name: 'test', level: 'silent' })
const OPTS = { locale: 'ja' as const, model: 'gemma4:e4b', provider: 'ollama' }

function makeAi(...responses: Array<string | Error>) {
  const complete = vi.fn()
  for (const response of responses) {
    if (response instanceof Error) complete.mockRejectedValueOnce(response)
    else complete.mockResolvedValueOnce(response)
  }
  return { ai: { complete } as unknown as AIAdapter, complete }
}

function makeStorage(content = 'こんにちは、テストです') {
  const downloadRange = vi.fn(async () => ({
    stream: Readable.from([Buffer.from(content)]),
    totalSize: content.length,
    start: 0,
    end: content.length - 1,
  }))
  return { storage: { downloadRange } as unknown as StorageAdapter, downloadRange }
}

/** Phase 1 output: one { name, description } per resource completion */
function resourceJson(name = 'リソース名', description = 'リソースの説明') {
  return JSON.stringify({ name, description })
}

/** Phase 2 output: the dataset integration completion. Defaults to one
 *  category pick — pkgDetail has none, so an empty pick would trigger the
 *  required-category regeneration */
function datasetJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: '提案タイトル',
    notes: '提案の説明文です。',
    tags: [],
    groups: ['disaster'],
    ...over,
  })
}

function resourceRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `resource-${id}`,
    description: null,
    format: 'txt',
    mimetype: null,
    size: 10,
    pipelineStatus: 'complete',
    ...over,
  }
}

function pkgDetail(
  resources: SuggestPackageDetail['resources'] = [],
  over: Partial<SuggestPackageDetail> = {}
): SuggestPackageDetail {
  return {
    id: 'pkg-1',
    state: 'active',
    title: '元のタイトル',
    notes: null,
    url: null,
    resources,
    tags: [{ name: '既存タグ' }],
    groups: [],
    organization: { title: 'テスト市' },
    ...over,
  }
}

const TAG_ROWS = [
  { id: 't1', name: '防災', vocabularyId: null, packageCount: 5, total: 2 },
  { id: 't2', name: '人口', vocabularyId: null, packageCount: 3, total: 2 },
]

const GROUP_ROWS = [
  { id: 'g1', name: 'tourism', title: '観光', state: 'active', total: 2, datasetCount: 1 },
  { id: 'g2', name: 'disaster', title: '防災・安全', state: 'active', total: 2, datasetCount: 1 },
]

/** Parse the JSON user content handed to ai.complete */
function sentContent(complete: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(complete.mock.calls[call][0])
}

/** Pipeline row for a completed resource with optional metadata/previewKey */
function pipe(id: string, metadata: unknown = {}, previewKey: string | null = null) {
  return { resourceId: id, status: 'complete', previewKey, metadata }
}

/** Live-object pointer rows, read alongside the pipeline rows (ADR-043) */
function liveKeys(...ids: string[]) {
  return ids.map((id) => ({ id, storageKey: `resources/pkg-1/${id}.tok` }))
}

/** Queue the tag + group candidate queries (consumed by every suggest call).
 *  Each side first resolves the user's org memberships for the
 *  visibility-scoped counts (packageVisibilitySql), so the two membership
 *  reads land before the two candidate queries */
function addCandidates(addResult: (rows: unknown[]) => void, groupRows: unknown[] = GROUP_ROWS) {
  addResult([])
  addResult([])
  addResult(TAG_ROWS)
  addResult(groupRows)
}

describe('MetadataSuggestService', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('suggests from metadata only and marks new vs candidate tags', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult) // no resources → only the candidate queries
    const { ai, complete } = makeAi(datasetJson({ tags: ['防災', '新規タグ'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(result.suggestion.title).toBe('提案タイトル')
    // Current tags come first (never removed), then the additions
    expect(result.suggestion.tags).toEqual([
      { name: '既存タグ', isNew: false },
      { name: '防災', isNew: false },
      { name: '新規タグ', isNew: true },
    ])
    expect(result.suggestion.groups).toEqual(['disaster'])
    expect(result.generatedBy).toEqual({ provider: 'ollama', model: 'gemma4:e4b' })
    expect(result.usedResources).toEqual([])

    // No resources → a single dataset completion
    expect(complete).toHaveBeenCalledTimes(1)
    const [content, options] = complete.mock.calls[0]
    expect(options.system).toContain('Japanese')
    expect(options.model).toBe('gemma4:e4b')
    expect(options.jsonSchema.name).toBe('suggest_metadata')
    // Active package → no URL-slug in the schema
    expect(options.jsonSchema.schema.required).toEqual(['title', 'notes', 'tags', 'groups'])
    const material = JSON.parse(content)
    expect(material.dataset.title).toBe('元のタイトル')
    expect(material.tagCandidates).toEqual(['防災', '人口'])
    expect(material.groupCandidates).toEqual([
      { name: 'tourism', title: '観光' },
      { name: 'disaster', title: '防災・安全' },
    ])
  })

  it('generates in English when locale is en', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(pkgDetail(), { id: 'u1' } as never, { ...OPTS, locale: 'en' })

    expect(complete.mock.calls[0][1].system).toContain('English')
  })

  it('runs one completion per resource, then integrates the results', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      resourceJson('r1の名前', 'r1の説明'),
      resourceJson('r2の名前', 'r2の説明'),
      datasetJson()
    )
    const { storage } = makeStorage('本文')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    // 2 resource completions + 1 dataset completion
    expect(complete).toHaveBeenCalledTimes(3)
    // Each resource call carries only that resource's material — no id, no siblings
    const first = sentContent(complete, 0)
    expect(first).toEqual({ resource: expect.objectContaining({ name: 'resource-r1' }) })
    expect(first.resource.id).toBeUndefined()
    expect(complete.mock.calls[0][1].jsonSchema).toEqual({
      name: 'suggest_resource',
      schema: expect.objectContaining({ required: ['name', 'description'] }),
    })
    expect(complete.mock.calls[0][1].system).toContain('one resource')
    // The dataset call sees the generated descriptions, not the raw material
    const dataset = sentContent(complete, 2)
    expect(dataset.resources).toEqual([
      { name: 'r1の名前', description: 'r1の説明', format: 'txt' },
      { name: 'r2の名前', description: 'r2の説明', format: 'txt' },
    ])
    expect(dataset.resources[0].textHead).toBeUndefined()
    // Phase 1 results map back to real resource ids
    expect(result.suggestion.resources).toEqual([
      { id: 'r1', name: 'r1の名前', description: 'r1の説明' },
      { id: 'r2', name: 'r2の名前', description: 'r2の説明' },
    ])
    expect(result.usedResources).toEqual(['r1', 'r2'])
  })

  it('degrades an all-blank resource result to lightweight context', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      resourceJson('', '  '),
      resourceJson('r2の名前', 'r2の説明'),
      datasetJson()
    )
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.resources).toEqual([
      { id: 'r2', name: 'r2の名前', description: 'r2の説明' },
    ])
    // The blank one joins otherResources so the dataset fields still know it exists
    const dataset = sentContent(complete, 2)
    expect(dataset.resources).toHaveLength(1)
    expect(dataset.otherResources).toEqual([{ name: 'resource-r1', format: 'txt' }])
    expect(result.usedResources).toEqual(['r2'])
    expect(result.skippedResources).toEqual(['r1'])
  })

  it('keeps going when one resource completion fails (graceful degradation)', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      new Error('Ollama chat failed: connection reset'),
      resourceJson('r2の名前', 'r2の説明'),
      datasetJson()
    )
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(complete).toHaveBeenCalledTimes(3)
    expect(result.suggestion.resources).toEqual([
      { id: 'r2', name: 'r2の名前', description: 'r2の説明' },
    ])
    expect(sentContent(complete, 2).otherResources).toEqual([
      { name: 'resource-r1', format: 'txt' },
    ])
    expect(result.skippedResources).toEqual(['r1'])
  })

  it('fails with 503 when every resource completion fails', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(new Error('provider down'), new Error('provider down'))
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)

    await expect(
      service.suggest(
        pkgDetail([resourceRow('r1'), resourceRow('r2')]),
        { id: 'u1' } as never,
        OPTS
      )
    ).rejects.toMatchObject({ status: 503 })
    // No dataset completion is attempted
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('retries a throttled completion with backoff', async () => {
    vi.useFakeTimers()
    try {
      const { db, addResult } = createMockDb()
      addCandidates(addResult)
      const { ai, complete } = makeAi(
        new Error('Bedrock invoke failed: ThrottlingException: Too many requests'),
        datasetJson()
      )
      const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

      const pending = service.suggest(pkgDetail(), { id: 'u1' } as never, {
        ...OPTS,
        provider: 'bedrock',
      })
      await vi.advanceTimersByTimeAsync(500)
      const result = await pending

      expect(complete).toHaveBeenCalledTimes(2)
      expect(result.suggestion.title).toBe('提案タイトル')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads head text from the storage original for text resources', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const { storage, downloadRange } = makeStorage('本文の先頭テキスト')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(downloadRange).toHaveBeenCalledWith('resources/pkg-1/r1.tok', 0, 16_383)
    expect(sentContent(complete).resource.textHead).toBe('本文の先頭テキスト')
    expect(result.usedResources).toEqual(['r1'])
    expect(result.skippedResources).toEqual([])
  })

  it('decodes head text with the encoding the Interpret step persisted', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', { encoding: 'Shift_JIS' })])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    // "名前" in Shift_JIS — the persisted encoding must win over chardet
    const downloadRange = vi.fn(async () => ({
      stream: Readable.from([Buffer.from([0x96, 0xbc, 0x91, 0x4f])]),
      totalSize: 4,
      start: 0,
      end: 3,
    }))
    const service = new MetadataSuggestService(
      db,
      { downloadRange } as unknown as StorageAdapter,
      ai,
      silentLogger
    )

    await service.suggest(pkgDetail([resourceRow('r1')]), { id: 'u1' } as never, OPTS)

    expect(sentContent(complete).resource.textHead).toBe('名前')
  })

  it('reads document text from the Index step artifact (ADR-040 addendum)', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', { textHeadKey: 'previews/pkg-1/r1.txt', textHeadBytes: 100 })])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const { storage, downloadRange } = makeStorage('PDFの抽出テキスト')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'pdf' })]),
      { id: 'u1' } as never,
      OPTS
    )

    // The artifact key from metadata, not the storage original — and no
    // encoding detection (the worker wrote it as UTF-8)
    expect(downloadRange).toHaveBeenCalledWith('previews/pkg-1/r1.txt', 0, 16_383)
    expect(sentContent(complete).resource.textHead).toBe('PDFの抽出テキスト')
    expect(result.usedResources).toEqual(['r1'])
    expect(result.skippedResources).toEqual([])
  })

  it('keeps documents without a text-head artifact as metadata-only', async () => {
    // Legacy formats (DOC/XLS/PPT) and documents whose extraction yielded no
    // text have no artifact — the metadata slot still applies
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const { storage, downloadRange } = makeStorage()
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'pdf' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(downloadRange).not.toHaveBeenCalled()
    expect(sentContent(complete).resource.textHead).toBeUndefined()
    expect(result.usedResources).toEqual([])
    expect(result.skippedResources).toEqual(['r1'])
  })

  it('lists ZIP manifest file paths (directories excluded, capped) with the true count', async () => {
    const manifest = {
      totalFiles: 60,
      totalSize: 1,
      totalCompressed: 1,
      truncated: false,
      entries: [
        { path: 'data/', size: 0, compressedSize: 0, lastModified: '', isDirectory: true },
        ...Array.from({ length: 60 }, (_, i) => ({
          path: `data/file${i}.csv`,
          size: 1,
          compressedSize: 1,
          lastModified: '',
          isDirectory: false,
        })),
      ],
    }
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', {}, 'previews/pkg-1/r1.json')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const download = vi.fn(async () => Readable.from([Buffer.from(JSON.stringify(manifest))]))
    const service = new MetadataSuggestService(
      db,
      { download } as unknown as StorageAdapter,
      ai,
      silentLogger
    )

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'zip' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(download).toHaveBeenCalledWith('previews/pkg-1/r1.json')
    const material = sentContent(complete).resource
    expect(material.files).toHaveLength(50)
    expect(material.files[0]).toBe('data/file0.csv')
    expect(material.files).not.toContain('data/')
    expect(material.fileCount).toBe(60)
    expect(result.usedResources).toEqual(['r1'])
  })

  it('degrades to metadata when the ZIP manifest exceeds the byte cap', async () => {
    // Entry paths are attacker-controlled — a >5MB manifest must abort the
    // read instead of buffering it wholesale
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', {}, 'previews/pkg-1/r1.json')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const download = vi.fn(async () =>
      Readable.from(
        (function* () {
          for (let i = 0; i < 6; i++) yield Buffer.alloc(1024 * 1024, 'x')
        })()
      )
    )
    const service = new MetadataSuggestService(
      db,
      { download } as unknown as StorageAdapter,
      ai,
      silentLogger
    )

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'zip' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(sentContent(complete).resource.files).toBeUndefined()
    expect(result.skippedResources).toEqual(['r1'])
  })

  it('uses the persisted schema (column-capped) and sample rows for CSV resources', async () => {
    const columns = Array.from({ length: 25 }, (_, i) => ({
      name: `col${i}`,
      type: 'string',
      nullable: false,
      nullCount: 0,
    }))
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', { schema: { columns, rowCount: 2 } })])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    mockQuery.mockResolvedValueOnce({ rows: [{ col0: '太郎' }], columns: ['col0'] })
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(mockQuery).toHaveBeenCalledWith('r1', 'SELECT * FROM data LIMIT 5', { id: 'u1' })
    const material = sentContent(complete).resource
    // Columns capped at 20; the true count is still reported
    expect(material.columns).toHaveLength(20)
    expect(material.columnCount).toBe(25)
    expect(material.rowCount).toBe(2)
    expect(material.sampleRows).toEqual([{ col0: '太郎' }])
    expect(result.usedResources).toEqual(['r1'])
  })

  it('projects sample rows onto the capped columns so wide tables stay lean', async () => {
    const columns = Array.from({ length: 40 }, (_, i) => ({
      name: `col${i}`,
      type: 'string',
      nullable: false,
      nullCount: 0,
    }))
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', { schema: { columns, rowCount: 1 } })])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    // The SELECT * row carries all 40 columns' values
    const wideRow = Object.fromEntries(columns.map((c) => [c.name, 'v']))
    mockQuery.mockResolvedValueOnce({ rows: [wideRow], columns: columns.map((c) => c.name) })
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    const material = sentContent(complete).resource
    // Sample row keys are limited to the same 20 columns, not all 40
    expect(Object.keys(material.sampleRows[0])).toHaveLength(20)
    expect(Object.keys(material.sampleRows[0])).toEqual(
      material.columns.map((c: { name: string }) => c.name)
    )
  })

  it('keeps ZIPs without a manifest as metadata-only', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'zip' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(sentContent(complete).resource.files).toBeUndefined()
    expect(result.skippedResources).toEqual(['r1'])
  })

  it('gives every resource a slot; only eligible ones carry content', async () => {
    const { db, addResult } = createMockDb()
    // r1 complete text (content-eligible); r2 still processing; r3 PDF
    addResult([pipe('r1'), { resourceId: 'r2', status: 'processing', metadata: {} }, pipe('r3')])
    addResult(liveKeys('r1', 'r2', 'r3'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      resourceJson('r1の名前', 'r1の説明'),
      resourceJson('r2の名前', 'r2の説明'),
      resourceJson('r3の名前', 'r3の説明'),
      datasetJson()
    )
    const { storage, downloadRange } = makeStorage('本文')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2'), resourceRow('r3', { format: 'pdf' })]),
      { id: 'u1' } as never,
      OPTS
    )

    // All three get their own completion; only the eligible one carries content
    expect(complete).toHaveBeenCalledTimes(4)
    expect(sentContent(complete, 0).resource.textHead).toBe('本文')
    expect(sentContent(complete, 1).resource.textHead).toBeUndefined()
    expect(sentContent(complete, 2).resource.textHead).toBeUndefined()
    expect(downloadRange).toHaveBeenCalledTimes(1)
    // used = content actually loaded; the others still got a name/description
    expect(result.usedResources).toEqual(['r1'])
    expect(result.skippedResources).toEqual(['r2', 'r3'])
    expect(result.suggestion.resources).toHaveLength(3)
  })

  it('keeps package order even when a later resource is the content-eligible one', async () => {
    const { db, addResult } = createMockDb()
    // r1 is a PDF (not eligible); r2 is complete text (eligible) — eligibility
    // decides which get a slot, but the output must stay in package order
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      resourceJson('r1の名前', 'r1の説明'),
      resourceJson('r2の名前', 'r2の説明'),
      datasetJson()
    )
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'pdf' }), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(sentContent(complete, 0).resource.textHead).toBeUndefined()
    expect(sentContent(complete, 1).resource.textHead).toBe('本文')
    expect(result.suggestion.resources.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('degrades to metadata when reading content fails', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson('r1の名前', 'r1の説明'), datasetJson())
    const storage = {
      downloadRange: vi.fn(async () => {
        throw new Error('NoSuchKey')
      }),
    } as unknown as StorageAdapter
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    // Still described (metadata slot) but content is absent
    expect(sentContent(complete).resource.textHead).toBeUndefined()
    // No content loaded → reported as skipped, but the description still applies
    expect(result.usedResources).toEqual([])
    expect(result.skippedResources).toEqual(['r1'])
    expect(result.suggestion.resources).toEqual([
      { id: 'r1', name: 'r1の名前', description: 'r1の説明' },
    ])
  })

  it('caps described resources at 20; the rest become otherResources', async () => {
    const resources = Array.from({ length: 22 }, (_, i) => resourceRow(`r${i + 1}`))
    const { db, addResult } = createMockDb()
    addResult(resources.map((r) => pipe(r.id)))
    addResult(liveKeys(...resources.map((r) => r.id)))
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      ...Array.from({ length: 20 }, () => resourceJson()),
      datasetJson()
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(resources), { id: 'u1' } as never, OPTS)

    expect(complete).toHaveBeenCalledTimes(21)
    const dataset = sentContent(complete, 20)
    expect(dataset.resources).toHaveLength(20)
    expect(dataset.otherResources).toHaveLength(2)
    expect(result.usedResources).toHaveLength(20)
    expect(result.skippedResources).toEqual(['r21', 'r22'])
  })

  it('clamps huge sample-row cells (LIMIT bounds rows, not cell size)', async () => {
    const { db, addResult } = createMockDb()
    addResult([
      pipe('r1', {
        schema: {
          columns: [
            { name: 'body', type: 'string', nullable: false, nullCount: 0 },
            { name: 'count', type: 'integer', nullable: false, nullCount: 0 },
          ],
          rowCount: 1,
        },
      }),
    ])
    addCandidates(addResult)
    mockQuery.mockResolvedValueOnce({ rows: [{ body: 'x'.repeat(10_000), count: 42 }] })
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    const [row] = sentContent(complete).resource.sampleRows
    expect(row.body).toHaveLength(201) // 200 chars + ellipsis
    expect(row.body.endsWith('…')).toBe(true)
    expect(row.count).toBe(42)
  })

  it('trims oversized text heads to the per-resource prompt budget', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    // The mock ignores the range, so the decoded head exceeds the budget
    const service = new MetadataSuggestService(
      db,
      makeStorage('x'.repeat(40_000)).storage,
      ai,
      silentLogger
    )

    await service.suggest(pkgDetail([resourceRow('r1')]), { id: 'u1' } as never, OPTS)

    const content = complete.mock.calls[0][0]
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(32_000)
    expect(sentContent(complete).resource.textHead.length).toBeGreaterThan(0)
  })

  it('clamps unbounded free-text columns so the budget holds', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson(), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { name: 'n'.repeat(200_000) })], {
        title: 't'.repeat(100_000),
        url: `https://x.test/${'u'.repeat(50_000)}`,
      }),
      { id: 'u1' } as never,
      OPTS
    )

    expect(sentContent(complete, 0).resource.name).toHaveLength(200)
    const dataset = sentContent(complete, 1)
    expect(dataset.dataset.title).toHaveLength(200)
    expect(Buffer.byteLength(complete.mock.calls[1][0])).toBeLessThanOrEqual(32_000)
  })

  it('retries once on invalid JSON and succeeds', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi('not json', datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.suggestion.title).toBe('提案タイトル')
  })

  it('gives up with 503 after two invalid JSON responses', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi('not json', '{"unexpected": true}')
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await expect(service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)).rejects.toMatchObject({
      status: 503,
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('fails fast with 503 on non-throttle provider errors (no retry)', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(new Error('Ollama chat failed: 404 model not found'))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await expect(service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('model not found'),
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('enforces tag limits (dedupe, ≤2 new, ≤5 total) and clamps lengths', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(liveKeys('r1'))
    addCandidates(addResult)
    const { ai } = makeAi(
      resourceJson(' 名前 ', ' 説明文 '),
      datasetJson({
        title: 'x'.repeat(300),
        tags: ['防災', '防災', '新規1', '新規2', '新規3', '人口', '', '  '],
      })
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    // 既存タグ is kept first; additions fill up to the 5-total cap
    expect(result.suggestion.tags).toEqual([
      { name: '既存タグ', isNew: false },
      { name: '防災', isNew: false },
      { name: '新規1', isNew: true },
      { name: '新規2', isNew: true },
      { name: '人口', isNew: false },
    ])
    expect(result.suggestion.resources).toEqual([{ id: 'r1', name: '名前', description: '説明文' }])
    expect(result.suggestion.title).toHaveLength(200)
  })

  it('accepts group picks by name or title, dropping unknowns and capping at 3', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai } = makeAi(
      datasetJson({ groups: ['観光', 'tourism', 'disaster', '存在しないグループ'] })
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    // Title echo resolves to the canonical name; duplicates and unknowns drop
    expect(result.suggestion.groups).toEqual(['tourism', 'disaster'])
  })

  it('refuses to resolve a title shared by multiple groups', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult, [
      { id: 'g1', name: 'tourism-a', title: '観光', state: 'active', total: 2, datasetCount: 1 },
      { id: 'g2', name: 'tourism-b', title: '観光', state: 'active', total: 2, datasetCount: 1 },
    ])
    const { ai } = makeAi(datasetJson({ groups: ['観光', 'tourism-b'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    // The ambiguous title is dropped; the explicit name still resolves
    expect(result.suggestion.groups).toEqual(['tourism-b'])
  })

  it('passes current group memberships to the integration call', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([], { groups: [{ name: 'tourism' }] }),
      { id: 'u1' } as never,
      OPTS
    )

    expect(sentContent(complete).dataset.groups).toEqual(['tourism'])
    // With a category already set, additions stay optional
    expect(complete.mock.calls[0][1].system).toContain('suggest additions only')
  })

  it('requires a category pick when the dataset has none yet', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(datasetJson({ groups: ['tourism'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(complete.mock.calls[0][1].system).toContain('The dataset has none yet')
    expect(result.suggestion.groups).toEqual(['tourism'])
  })

  it('regenerates once when the required category is missing', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(
      datasetJson({ groups: [] }),
      datasetJson({ groups: ['tourism'], title: '再生成タイトル' })
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.suggestion.groups).toEqual(['tourism'])
    expect(result.suggestion.title).toBe('再生成タイトル')
  })

  it('accepts a category-less suggestion after the regeneration also misses', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(datasetJson({ groups: [] }), datasetJson({ groups: [] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    // Best-effort, not a hard failure — the rest of the suggestion survives
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.suggestion.groups).toEqual([])
    expect(result.suggestion.title).toBe('提案タイトル')
  })

  it('clamps unbounded group titles and drops candidate tails to fit the budget', async () => {
    const { db, addResult } = createMockDb()
    // 200 candidates with maximal titles exceed the 32KB dataset budget
    addCandidates(
      addResult,
      Array.from({ length: 200 }, (_, i) => ({
        id: `g${i}`,
        name: `group-${i}`,
        title: 'た'.repeat(10_000),
        state: 'active',
        total: 200,
        datasetCount: 1,
      }))
    )
    // A pick the ladder trimmed from the prompt copy must still validate
    const { ai, complete } = makeAi(datasetJson({ groups: ['group-199'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    const material = sentContent(complete)
    expect(material.groupCandidates[0].title).toHaveLength(200)
    expect(material.groupCandidates.length).toBeLessThan(200)
    expect(Buffer.byteLength(complete.mock.calls[0][0])).toBeLessThanOrEqual(32_000)
    expect(result.suggestion.groups).toEqual(['group-199'])
  })

  it('keeps current memberships even when the model omits them', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai } = makeAi(datasetJson({ groups: ['tourism'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([], { groups: [{ name: 'legacy-group' }] }),
      { id: 'u1' } as never,
      OPTS
    )

    // Additions-only: legacy-group survives regardless of the model's output
    expect(result.suggestion.groups).toEqual(['legacy-group', 'tourism'])
  })

  it('skips resource completions once the request deadline is reached', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(liveKeys('r1', 'r2'))
    addCandidates(addResult)
    const { ai, complete } = makeAi(resourceJson('r1の名前', 'r1の説明'), datasetJson())
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)
    // startedAt = 0, r1 launches at 0 (skip + attempt checks), r2 would
    // launch past the deadline
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(200_000)
    try {
      const result = await service.suggest(
        pkgDetail([resourceRow('r1'), resourceRow('r2')]),
        { id: 'u1' } as never,
        OPTS
      )

      // r1 + dataset only — r2 was never sent to the LLM
      expect(complete).toHaveBeenCalledTimes(2)
      expect(result.suggestion.resources).toEqual([
        { id: 'r1', name: 'r1の名前', description: 'r1の説明' },
      ])
      expect(result.skippedResources).toContain('r2')
    } finally {
      now.mockRestore()
    }
  })

  it('suggests a normalized unique URL slug for drafts', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    addResult([]) // name uniqueness lookup — free
    const { ai, complete } = makeAi(datasetJson({ name: ' Niigata_Population Data! ' }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([], { state: 'draft' }),
      { id: 'u1' } as never,
      OPTS
    )

    // Drafts request the slug in the output schema...
    expect(complete.mock.calls[0][1].jsonSchema.schema.required).toContain('name')
    expect(complete.mock.calls[0][1].system).toContain('URL slug')
    // ...and the result is normalized to the package.name contract
    expect(result.suggestion.name).toBe('niigata-population-data')
  })

  it('suffixes the slug when it collides with an existing package', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    addResult([{ id: 'other-pkg', name: 'population' }]) // base taken, -2 free
    const { ai } = makeAi(datasetJson({ name: 'population' }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([], { state: 'draft' }),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.name).toBe('population-2')
  })

  it('keeps the slug when the only collision is the draft itself', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    addResult([{ id: 'pkg-1', name: 'population' }]) // "taken" by the package being suggested
    const { ai } = makeAi(datasetJson({ name: 'population' }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([], { state: 'draft' }),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.name).toBe('population')
  })

  it('omits the slug when it cannot be normalized', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai } = makeAi(datasetJson({ name: '日本語のみのスラッグ' }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([], { state: 'draft' }),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.name).toBeUndefined()
  })

  it('never asks for a slug on published packages', async () => {
    const { db, addResult } = createMockDb()
    addCandidates(addResult)
    const { ai, complete } = makeAi(datasetJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(complete.mock.calls[0][1].jsonSchema.schema.required).not.toContain('name')
    expect(result.suggestion.name).toBeUndefined()
  })
})
