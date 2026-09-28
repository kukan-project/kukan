import { describe, it, expect } from 'vitest'
import { buildResourceEmbeddingText } from '../embed/embed-resources'
import { MAX_EMBED_TEXT_LENGTH } from '../config'

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

  it('produces nothing when the package and the resource are both wordless', () => {
    // The emptiness this returns is what the worker reads as "no embedding to
    // make here", and what `GET /admin/embedding-status` mirrors in SQL so its
    // prompt does not count a resource that will be skipped forever. Pinned
    // because the two live apart: a builder that started emitting something
    // for this input would leave that query counting the wrong rows.
    expect(
      buildResourceEmbeddingText({
        title: null,
        tags: [],
        section: null,
        name: null,
        description: null,
        summary: null,
      })
    ).toBe('')
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
