import { describe, it, expect } from 'vitest'
import { buildEmbeddingText } from '../embed/embed-package'
import { MAX_EMBED_TEXT_LENGTH } from '../config'

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
