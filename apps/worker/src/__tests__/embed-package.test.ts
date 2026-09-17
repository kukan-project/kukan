import { describe, it, expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { buildResourceEmbeddingText, embedPackage } from '../embed/embed-package'
import { EMBED_BATCH_SIZE, MAX_EMBED_TEXT_LENGTH } from '../config'
import { tag, resource, type Database } from '@kukan/db'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'

describe('buildResourceEmbeddingText', () => {
  it('puts the package context ahead of the resource, the abstract last', () => {
    const text = buildResourceEmbeddingText({
      title: '人口統計2024',
      tags: ['人口', '統計'],
      section: '地区別',
      name: '地区別人口.csv',
      description: '地区ごとの人口',
      summary: '地区ごとの人口を収録した表である。',
    })
    expect(text).toBe(
      '人口統計2024\n人口 統計\n地区別\n地区別人口.csv\n地区ごとの人口\n地区ごとの人口を収録した表である。'
    )
  })

  it('leaves out an abstract an editor hid, and empty parts', () => {
    const text = buildResourceEmbeddingText({
      title: '人口統計',
      tags: [],
      section: null,
      name: 'a.csv',
      description: null,
      summary: null,
    })
    expect(text).toBe('人口統計\na.csv')
  })

  it('drops the trailing sentence rather than cutting one in half', () => {
    const sentence = 'これは抄録の一文である。'
    const text = buildResourceEmbeddingText({
      title: 'x',
      tags: [],
      section: null,
      name: null,
      description: null,
      summary: sentence.repeat(Math.ceil(MAX_EMBED_TEXT_LENGTH / sentence.length) + 1),
    })
    expect(text.length).toBeLessThanOrEqual(MAX_EMBED_TEXT_LENGTH)
    expect(text.endsWith('。')).toBe(true)
  })

  it('returns empty string when there is nothing to embed', () => {
    expect(
      buildResourceEmbeddingText({
        title: null,
        tags: [],
        section: null,
        name: null,
        description: null,
      })
    ).toBe('')
  })

  it('keeps the title when the description would fill the budget', () => {
    // The package's title and tags are what land a thin resource on the right
    // package; a description too long to fit is cut, they are not
    const text = buildResourceEmbeddingText({
      title: 'タイトル',
      tags: ['t'],
      section: null,
      name: '13_shisetsu.csv',
      description: 'd'.repeat(MAX_EMBED_TEXT_LENGTH + 1000),
      summary: null,
    })
    expect(text.length).toBeLessThanOrEqual(MAX_EMBED_TEXT_LENGTH)
    expect(text.startsWith('タイトル\nt\n13_shisetsu.csv')).toBe(true)
  })

  it('reserves room for the resource when the title and tags would fill the budget', () => {
    // Neither is bounded by the API. Without a reserve every resource of such
    // a package would embed the same text — the head — and share one vector.
    const text = buildResourceEmbeddingText({
      title: 'タ'.repeat(MAX_EMBED_TEXT_LENGTH + 1000),
      tags: ['t'],
      section: null,
      name: '13_shisetsu.csv',
      description: null,
      summary: '施設の一覧。',
    })
    expect(text.length).toBeLessThanOrEqual(MAX_EMBED_TEXT_LENGTH)
    expect(text.endsWith('\n13_shisetsu.csv\n施設の一覧。')).toBe(true)
  })

  it('truncates to MAX_EMBED_TEXT_LENGTH', () => {
    const text = buildResourceEmbeddingText({
      title: 'a'.repeat(MAX_EMBED_TEXT_LENGTH + 1000),
      tags: [],
      section: null,
      name: null,
      description: null,
    })
    expect(text).toHaveLength(MAX_EMBED_TEXT_LENGTH)
  })
})

/** Minimal Drizzle stub: a thenable chain — each await returns the next queued result */
function mockDb(results: unknown[][]): {
  db: Database
  updates: unknown[]
  /** Raw statements, rendered to SQL text and bound parameters */
  executed: () => Array<{ sql: string; params: unknown[] }>
  orderByCalls: unknown[][]
} {
  let i = 0
  const updates: unknown[] = []
  const executed: SQL[] = []
  const orderByCalls: unknown[][] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    then: (resolve: (v: unknown) => void) => resolve(results[i++] ?? []),
    set: (arg: unknown) => (updates.push(arg), chain),
    orderBy: (...args: unknown[]) => (orderByCalls.push(args), chain),
    execute: async (q: SQL) => void executed.push(q),
  }
  for (const method of ['select', 'from', 'innerJoin', 'where', 'limit', 'update']) {
    chain[method] = () => chain
  }
  const dialect = new PgDialect()
  return {
    db: chain as Database,
    updates,
    executed: () => executed.map((q) => dialect.sqlToQuery(q)),
    orderByCalls,
  }
}

const batchFn = () => vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3]))

function makeAi(embedBatch = batchFn()) {
  return {
    getEmbeddingInfo: () => ({ model: 'test-model', dimensions: 3 }),
    embedBatch,
  } as unknown as AIAdapter
}

const log = { warn: vi.fn() } as unknown as Logger
const pkg = { state: 'active', title: 'タイトル' }

/** A resource row as the step reads it; the text it embeds is title + name */
function row(
  id: string,
  name: string | null,
  embeddingModel: string | null,
  embeddingHash: string | null
) {
  return {
    id,
    name,
    description: null,
    section: null,
    summary: null,
    summaryMeta: {},
    embeddingModel,
    embeddingHash,
  }
}
const hashOf = (name: string) => createHash('sha256').update(`タイトル\n${name}`).digest('hex')

describe('embedPackage — per-resource re-embed decision (ADR-054)', () => {
  it('re-embeds when the stored key lacks the dimension (legacy model-only value)', async () => {
    const embedBatch = batchFn()
    // Hash matches, but stored 'test-model' != key 'test-model@3'
    const { db, executed } = mockDb([
      [pkg],
      [],
      [row('r1', 'a.csv', 'test-model', hashOf('a.csv'))],
    ])

    const result = await embedPackage('pkg-1', db, makeAi(embedBatch), log)

    expect(result).toBe('embedded')
    expect(embedBatch).toHaveBeenCalledOnce()
    expect(executed()).toHaveLength(1)
    expect(executed()[0].params).toContain('test-model@3')
  })

  it('embeds only the resources whose text or key moved', async () => {
    const embedBatch = batchFn()
    const { db, executed } = mockDb([
      [pkg],
      [],
      [
        row('same', 'a.csv', 'test-model@3', hashOf('a.csv')),
        row('changed', 'b.csv', 'test-model@3', 'stale'),
        row('never', 'c.csv', null, null),
      ],
    ])

    const result = await embedPackage('pkg-1', db, makeAi(embedBatch), log)

    expect(result).toBe('embedded')
    // One call for the whole batch, holding only the two that need it
    expect(embedBatch).toHaveBeenCalledOnce()
    expect(embedBatch.mock.calls[0][0]).toEqual(['タイトル\nb.csv', 'タイトル\nc.csv'])
    // And one statement writing both back, not one per resource
    expect(executed()).toHaveLength(1)
    expect(executed()[0].params).toEqual(expect.arrayContaining(['changed', 'never']))
    expect(executed()[0].params).not.toContain('same')
  })

  it('embeds a large package in fixed batches, each written before the next', async () => {
    const embedBatch = batchFn()
    const rows = Array.from({ length: EMBED_BATCH_SIZE * 2 + 1 }, (_, i) =>
      row(`r${i}`, `${i}.csv`, null, null)
    )
    const { db, executed } = mockDb([[pkg], [], rows])

    expect(await embedPackage('pkg-1', db, makeAi(embedBatch), log)).toBe('embedded')

    // Three calls of at most EMBED_BATCH_SIZE, three statements — never one
    // request holding the whole package, which OpenAI and Ollama would send whole
    expect(embedBatch).toHaveBeenCalledTimes(3)
    expect(embedBatch.mock.calls.map((c) => c[0].length)).toEqual([
      EMBED_BATCH_SIZE,
      EMBED_BATCH_SIZE,
      1,
    ])
    expect(executed()).toHaveLength(3)
  })

  it('keeps the batches already written when a later one fails', async () => {
    const embedBatch = vi
      .fn()
      .mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 2, 3]))
      .mockRejectedValueOnce(new Error('provider down'))
    const rows = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, i) =>
      row(`r${i}`, `${i}.csv`, null, null)
    )
    const { db, executed } = mockDb([[pkg], [], rows])

    await expect(embedPackage('pkg-1', db, makeAi(embedBatch), log)).rejects.toThrow(
      'provider down'
    )

    // The first batch reached the table; the retry resumes past it by hash
    expect(executed()).toHaveLength(1)
  })

  it('skips a package whose every resource is already embedded', async () => {
    const embedBatch = vi.fn()
    const { db } = mockDb([[pkg], [], [row('r1', 'a.csv', 'test-model@3', hashOf('a.csv'))]])

    expect(await embedPackage('pkg-1', db, makeAi(embedBatch), log)).toBe('skipped')
    expect(embedBatch).not.toHaveBeenCalled()
  })

  it('clears a resource that no longer has anything to embed', async () => {
    const embedBatch = vi.fn()
    const { db, updates } = mockDb([
      [{ ...pkg, title: null }],
      [],
      [row('r1', null, 'test-model@3', 'whatever')],
    ])

    expect(await embedPackage('pkg-1', db, makeAi(embedBatch), log)).toBe('cleared')
    expect(updates[0]).toEqual({ embedding: null, embeddingModel: null, embeddingHash: null })
    expect(embedBatch).not.toHaveBeenCalled()
  })

  it('orders tags and resources deterministically (hash stability across reindex)', async () => {
    const { db, orderByCalls } = mockDb([[pkg], [], []])

    await embedPackage('pkg-1', db, makeAi(), log)

    const [tagOrder, resourceOrder] = orderByCalls
    expect(tagOrder[0]).toBe(tag.name)
    expect(resourceOrder[0]).toBe(resource.position)
    expect(resourceOrder[1]).toBe(resource.created)
    expect(resourceOrder[2]).toBe(resource.id)
  })

  it('skips draft packages without embedding (ADR-039)', async () => {
    const embedBatch = vi.fn()
    const { db } = mockDb([[{ ...pkg, state: 'draft' }]])

    expect(await embedPackage('pkg-1', db, makeAi(embedBatch), log)).toBe('skipped')
    expect(embedBatch).not.toHaveBeenCalled()
  })
})
