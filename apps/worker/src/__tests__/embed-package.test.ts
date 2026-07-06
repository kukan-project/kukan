import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildEmbeddingText, embedPackage } from '../embed/embed-package'
import { MAX_EMBED_TEXT_LENGTH } from '../config'
import { tag, resource, type Database } from '@kukan/db'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'

describe('buildEmbeddingText', () => {
  it('joins title, notes, tags, and resource metadata with newlines', () => {
    const text = buildEmbeddingText({
      title: '人口統計2024',
      notes: '市の人口統計データ',
      tags: ['人口', '統計'],
      resources: [
        { name: '地区別人口.csv', description: '地区ごとの人口' },
        { name: '年齢別世帯数.csv', description: null },
      ],
    })
    expect(text).toBe(
      '人口統計2024\n市の人口統計データ\n人口 統計\n地区別人口.csv 地区ごとの人口\n年齢別世帯数.csv'
    )
  })

  it('skips empty parts', () => {
    const text = buildEmbeddingText({
      title: 'タイトルのみ',
      notes: null,
      tags: [],
      resources: [],
    })
    expect(text).toBe('タイトルのみ')
  })

  it('returns empty string when there is nothing to embed', () => {
    expect(buildEmbeddingText({ title: null, notes: null, tags: [], resources: [] })).toBe('')
  })

  it('truncates to MAX_EMBED_TEXT_LENGTH', () => {
    const text = buildEmbeddingText({
      title: 'a'.repeat(MAX_EMBED_TEXT_LENGTH + 1000),
      notes: null,
      tags: [],
      resources: [],
    })
    expect(text).toHaveLength(MAX_EMBED_TEXT_LENGTH)
  })
})

/** Minimal Drizzle stub: a thenable chain — each await returns the next queued result */
function mockDb(results: unknown[][]): {
  db: Database
  updated: () => unknown
  orderByCalls: unknown[][]
} {
  let i = 0
  let updateArg: unknown
  const orderByCalls: unknown[][] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    then: (resolve: (v: unknown) => void) => resolve(results[i++] ?? []),
    set: (arg: unknown) => ((updateArg = arg), chain),
    orderBy: (...args: unknown[]) => (orderByCalls.push(args), chain),
  }
  for (const method of ['select', 'from', 'innerJoin', 'where', 'limit', 'update']) {
    chain[method] = () => chain
  }
  return { db: chain as Database, updated: () => updateArg, orderByCalls }
}

function makeAi(embed = vi.fn().mockResolvedValue([1, 2, 3])) {
  return {
    getEmbeddingInfo: () => ({ model: 'test-model', dimensions: 3 }),
    embed,
  } as unknown as AIAdapter
}

const log = { warn: vi.fn() } as unknown as Logger

describe('embedPackage — re-embed decision', () => {
  const pkgText = 'タイトル' // title-only package → buildEmbeddingText === title
  const currentHash = createHash('sha256').update(pkgText).digest('hex')

  function pkgRow(embeddingModel: string | null, embeddingHash: string | null) {
    return { title: pkgText, notes: null, embeddingModel, embeddingHash }
  }

  it('re-embeds when the stored key lacks the dimension (legacy model-only value)', async () => {
    const embed = vi.fn().mockResolvedValue([1, 2, 3])
    // Hash matches, but stored 'test-model' != key 'test-model@3'
    const { db, updated } = mockDb([[pkgRow('test-model', currentHash)], [], []])

    const result = await embedPackage('pkg-1', db, makeAi(embed), log)

    expect(result).toBe('embedded')
    expect(embed).toHaveBeenCalledOnce()
    expect(updated()).toMatchObject({ embeddingModel: 'test-model@3' })
  })

  it('skips when the stored key already includes the current dimension', async () => {
    const embed = vi.fn()
    const { db } = mockDb([[pkgRow('test-model@3', currentHash)], [], []])

    const result = await embedPackage('pkg-1', db, makeAi(embed), log)

    expect(result).toBe('skipped')
    expect(embed).not.toHaveBeenCalled()
  })

  it('orders tags and resources deterministically (hash stability across reindex)', async () => {
    const { db, orderByCalls } = mockDb([[pkgRow(null, null)], [], []])

    await embedPackage('pkg-1', db, makeAi(), log)

    // The hash input depends on these orders (queries run in Promise.all order)
    const [tagOrder, resourceOrder] = orderByCalls
    expect(tagOrder[0]).toBe(tag.name)
    expect(resourceOrder[0]).toBe(resource.position)
    expect(resourceOrder[1]).toBe(resource.created)
    expect(resourceOrder[2]).toBe(resource.id)
  })
})
