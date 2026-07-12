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

/** LLM output in the new shape: resourceSuggestions keyed by index */
function llmJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: '提案タイトル',
    notes: '提案の説明文です。',
    tags: [],
    resourceSuggestions: {},
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
    title: '元のタイトル',
    notes: null,
    url: null,
    resources,
    tags: [{ name: '既存タグ' }],
    organization: { title: 'テスト市' },
    ...over,
  }
}

const TAG_ROWS = [
  { id: 't1', name: '防災', vocabularyId: null, packageCount: 5, total: 2 },
  { id: 't2', name: '人口', vocabularyId: null, packageCount: 3, total: 2 },
]

/** Parse the JSON user content handed to ai.complete */
function sentContent(complete: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(complete.mock.calls[call][0])
}

/** Pipeline row for a completed resource with optional metadata */
function pipe(id: string, metadata: unknown = {}) {
  return { resourceId: id, status: 'complete', metadata }
}

describe('MetadataSuggestService', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('suggests from metadata only and marks new vs candidate tags', async () => {
    const { db, addResult } = createMockDb()
    addResult(TAG_ROWS) // no resources → only the tag-candidates query
    const { ai, complete } = makeAi(llmJson({ tags: ['防災', '新規タグ'] }))
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(result.suggestion.title).toBe('提案タイトル')
    expect(result.suggestion.tags).toEqual([
      { name: '防災', isNew: false },
      { name: '新規タグ', isNew: true },
    ])
    expect(result.generatedBy).toEqual({ provider: 'ollama', model: 'gemma4:e4b' })
    expect(result.usedResources).toEqual([])

    const [content, options] = complete.mock.calls[0]
    expect(options.system).toContain('Japanese')
    expect(options.model).toBe('gemma4:e4b')
    // No resources → resourceSuggestions has no required keys
    expect(options.jsonSchema.name).toBe('suggest_metadata')
    expect(options.jsonSchema.schema.properties.resourceSuggestions.required).toEqual([])
    const material = JSON.parse(content)
    expect(material.dataset.title).toBe('元のタイトル')
    expect(material.tagCandidates).toEqual(['防災', '人口'])
  })

  it('generates in English when locale is en', async () => {
    const { db, addResult } = createMockDb()
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(pkgDetail(), { id: 'u1' } as never, { ...OPTS, locale: 'en' })

    expect(complete.mock.calls[0][1].system).toContain('English')
  })

  it('describes resources by index and maps them back to ids', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1'), pipe('r2')])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(
      llmJson({
        resourceSuggestions: {
          '0': { name: 'r1の名前', description: 'r1の説明' },
          '1': { name: 'r2の名前', description: 'r2の説明' },
        },
      })
    )
    const { storage } = makeStorage('本文')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    // Prompt uses index (0,1), not the UUID
    const sent = sentContent(complete).resources
    expect(sent.map((r: { index: number }) => r.index)).toEqual([0, 1])
    expect(sent[0].id).toBeUndefined()
    // Required keys force a suggestion per described resource
    expect(
      complete.mock.calls[0][1].jsonSchema.schema.properties.resourceSuggestions.required
    ).toEqual(['0', '1'])
    // index → id mapping in the response
    expect(result.suggestion.resources).toEqual([
      { id: 'r1', name: 'r1の名前', description: 'r1の説明' },
      { id: 'r2', name: 'r2の名前', description: 'r2の説明' },
    ])
    expect(result.usedResources).toEqual(['r1', 'r2'])
  })

  it('drops out-of-range keys and entries with neither name nor description', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(TAG_ROWS)
    const { ai } = makeAi(
      llmJson({
        resourceSuggestions: {
          '0': { name: '名前', description: '有効' },
          '9': { name: 'x', description: '存在しないindex' },
          '1': { name: '', description: '  ' },
        },
      })
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.resources).toEqual([{ id: 'r1', name: '名前', description: '有効' }])
  })

  it('reads head text from the storage original for text resources', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
    const { storage, downloadRange } = makeStorage('本文の先頭テキスト')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(downloadRange).toHaveBeenCalledWith('resources/pkg-1/r1', 0, 16_383)
    expect(sentContent(complete).resources[0].textHead).toBe('本文の先頭テキスト')
    expect(result.usedResources).toEqual(['r1'])
    expect(result.skippedResources).toEqual([])
  })

  it('decodes head text with the encoding the Extract step persisted', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1', { encoding: 'Shift_JIS' })])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
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

    expect(sentContent(complete).resources[0].textHead).toBe('名前')
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
    addResult(TAG_ROWS)
    mockQuery.mockResolvedValueOnce({ rows: [{ col0: '太郎' }], columns: ['col0'] })
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(mockQuery).toHaveBeenCalledWith('r1', 'SELECT * FROM data LIMIT 5', { id: 'u1' })
    const material = sentContent(complete).resources[0]
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
    addResult(TAG_ROWS)
    // The SELECT * row carries all 40 columns' values
    const wideRow = Object.fromEntries(columns.map((c) => [c.name, 'v']))
    mockQuery.mockResolvedValueOnce({ rows: [wideRow], columns: columns.map((c) => c.name) })
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    const material = sentContent(complete).resources[0]
    // Sample row keys are limited to the same 20 columns, not all 40
    expect(Object.keys(material.sampleRows[0])).toHaveLength(20)
    expect(Object.keys(material.sampleRows[0])).toEqual(
      material.columns.map((c: { name: string }) => c.name)
    )
  })

  it('gives every resource a slot; only eligible ones carry content', async () => {
    const { db, addResult } = createMockDb()
    // r1 complete text (content-eligible); r2 still processing; r3 PDF
    addResult([pipe('r1'), { resourceId: 'r2', status: 'processing', metadata: {} }, pipe('r3')])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(
      llmJson({
        resourceSuggestions: {
          '0': { name: 'r1の名前', description: 'r1の説明' },
          '1': { name: 'r2の名前', description: 'r2の説明' },
          '2': { name: 'r3の名前', description: 'r3の説明' },
        },
      })
    )
    const { storage, downloadRange } = makeStorage('本文')
    const service = new MetadataSuggestService(db, storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1'), resourceRow('r2'), resourceRow('r3', { format: 'pdf' })]),
      { id: 'u1' } as never,
      OPTS
    )

    const sent = sentContent(complete)
    // All three get a slot; only the content-eligible one carries content
    expect(sent.resources).toHaveLength(3)
    expect(sent.resources[0].index).toBe(0)
    expect(sent.resources[0].textHead).toBe('本文')
    // The non-eligible ones have a slot but no content material
    expect(sent.resources.slice(1).every((r: { textHead?: string }) => !r.textHead)).toBe(true)
    expect(sent.otherResources).toBeUndefined()
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
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(
      llmJson({
        resourceSuggestions: {
          '0': { name: 'r1の名前', description: 'r1の説明' },
          '1': { name: 'r2の名前', description: 'r2の説明' },
        },
      })
    )
    const service = new MetadataSuggestService(db, makeStorage('本文').storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'pdf' }), resourceRow('r2')]),
      { id: 'u1' } as never,
      OPTS
    )

    // r1 (PDF) stays at index 0; r2 (eligible) at index 1 with its content
    const sent = sentContent(complete)
    expect(sent.resources.map((r: { index: number }) => r.index)).toEqual([0, 1])
    expect(sent.resources[0].textHead).toBeUndefined()
    expect(sent.resources[1].textHead).toBe('本文')
    expect(result.suggestion.resources.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('degrades to metadata when reading content fails', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(
      llmJson({ resourceSuggestions: { '0': { name: 'r1の名前', description: 'r1の説明' } } })
    )
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

    // Still described (metadata + description slot) but content is absent
    const sent = sentContent(complete).resources[0]
    expect(sent.index).toBe(0)
    expect(sent.textHead).toBeUndefined()
    // No content loaded → reported as skipped, but the description still applies
    expect(result.usedResources).toEqual([])
    expect(result.skippedResources).toEqual(['r1'])
    expect(result.suggestion.resources).toEqual([
      { id: 'r1', name: 'r1の名前', description: 'r1の説明' },
    ])
  })

  it('caps described resources at 10; the rest become otherResources', async () => {
    const resources = Array.from({ length: 12 }, (_, i) => resourceRow(`r${i + 1}`))
    const { db, addResult } = createMockDb()
    addResult(resources.map((r) => pipe(r.id)))
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(resources), { id: 'u1' } as never, OPTS)

    const sent = sentContent(complete)
    expect(sent.resources).toHaveLength(10)
    expect(sent.otherResources).toHaveLength(2)
    expect(result.usedResources).toHaveLength(10)
    expect(result.skippedResources).toEqual(['r11', 'r12'])
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
    addResult(TAG_ROWS)
    mockQuery.mockResolvedValueOnce({ rows: [{ body: 'x'.repeat(10_000), count: 42 }] })
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { format: 'csv' })]),
      { id: 'u1' } as never,
      OPTS
    )

    const [row] = sentContent(complete).resources[0].sampleRows
    expect(row.body).toHaveLength(201) // 200 chars + ellipsis
    expect(row.body.endsWith('…')).toBe(true)
    expect(row.count).toBe(42)
  })

  it('trims content to the prompt byte budget, keeping described metadata', async () => {
    const resources = Array.from({ length: 10 }, (_, i) => resourceRow(`r${i + 1}`))
    const { db, addResult } = createMockDb()
    addResult(resources.map((r) => pipe(r.id)))
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(
      db,
      makeStorage('x'.repeat(16_384)).storage,
      ai,
      silentLogger
    )

    const result = await service.suggest(pkgDetail(resources), { id: 'u1' } as never, OPTS)

    const content = complete.mock.calls[0][0]
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64_000)
    expect(JSON.parse(content).resources).toHaveLength(10) // described metadata kept
    expect(result.usedResources.length).toBeGreaterThan(0)
  })

  it('clamps unbounded free-text columns so the budget holds even for one resource', async () => {
    const { db, addResult } = createMockDb()
    addResult([pipe('r1')])
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi(llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await service.suggest(
      pkgDetail([resourceRow('r1', { name: 'n'.repeat(200_000) })], {
        title: 't'.repeat(100_000),
        url: `https://x.test/${'u'.repeat(50_000)}`,
      }),
      { id: 'u1' } as never,
      OPTS
    )

    const content = complete.mock.calls[0][0]
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64_000)
    const material = JSON.parse(content)
    expect(material.resources[0].name).toHaveLength(200)
    expect(material.dataset.title).toHaveLength(200)
  })

  it('retries once on invalid JSON and succeeds', async () => {
    const { db, addResult } = createMockDb()
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi('not json', llmJson())
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.suggestion.title).toBe('提案タイトル')
  })

  it('gives up with 503 after two invalid JSON responses', async () => {
    const { db, addResult } = createMockDb()
    addResult(TAG_ROWS)
    const { ai, complete } = makeAi('not json', '{"unexpected": true}')
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    await expect(service.suggest(pkgDetail(), { id: 'u1' } as never, OPTS)).rejects.toMatchObject({
      status: 503,
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('fails fast with 503 on provider errors (no retry)', async () => {
    const { db, addResult } = createMockDb()
    addResult(TAG_ROWS)
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
    addResult(TAG_ROWS)
    const { ai } = makeAi(
      llmJson({
        title: 'x'.repeat(300),
        tags: ['防災', '防災', '新規1', '新規2', '新規3', '人口', '', '  '],
        resourceSuggestions: { '0': { name: ' 名前 ', description: ' 説明文 ' } },
      })
    )
    const service = new MetadataSuggestService(db, makeStorage().storage, ai, silentLogger)

    const result = await service.suggest(
      pkgDetail([resourceRow('r1')]),
      { id: 'u1' } as never,
      OPTS
    )

    expect(result.suggestion.tags).toEqual([
      { name: '防災', isNew: false },
      { name: '新規1', isNew: true },
      { name: '新規2', isNew: true },
      { name: '人口', isNew: false },
    ])
    expect(result.suggestion.resources).toEqual([{ id: 'r1', name: '名前', description: '説明文' }])
    expect(result.suggestion.title).toHaveLength(200)
  })
})
