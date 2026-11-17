import { describe, it, expect } from 'vitest'
import { NATIONWIDE, NATIONWIDE_ROOTS, vocabularySearchFields } from '../vocabulary-search'

const vocabulary = (extra: Record<string, unknown>) => ({
  concept: 'admin-area',
  pack: 'JP',
  scheme: 'jp-area-code',
  representation: 'code6',
  share: 1,
  ambiguous: 0,
  levels: [],
  periods: [{}],
  narrowedBy: [],
  kind: 'code',
  ...extra,
})

describe('vocabularySearchFields', () => {
  it('takes the union of the columns, with each place under the roots it lies in', () => {
    expect(
      vocabularySearchFields([
        vocabulary({ places: ['131016', '131024'], roots: ['130001'] }),
        vocabulary({ kind: 'name', places: ['271004'], roots: ['270008'] }),
      ])
    ).toEqual({
      vocab_meanings: ['admin-area:code', 'admin-area:name'],
      area_roots: ['130001', '270008'],
      area_places: ['131016', '131024', '271004'],
    })
  })

  it('keeps a top-level place out of the places below them', () => {
    // A column of prefectures: Tokyo is a root, never a municipality
    expect(vocabularySearchFields([vocabulary({ places: ['130001'], roots: ['130001'] })])).toEqual(
      {
        vocab_meanings: ['admin-area:code'],
        area_roots: ['130001'],
      }
    )
  })

  it('takes a table covering most of the top-level places for nationwide, whichever columns cover them', () => {
    const roots = Array.from(
      { length: NATIONWIDE_ROOTS },
      (_, i) => `${i + 1}`.padStart(2, '0') + '0000'
    )
    // A column of prefecture codes and one of municipalities: together they are the whole country
    expect(
      vocabularySearchFields([
        vocabulary({ places: roots.slice(0, 20), roots: roots.slice(0, 20) }),
        vocabulary({ kind: 'name', places: ['131016'], roots: roots.slice(20) }),
      ])
    ).toEqual({ vocab_meanings: ['admin-area:code', 'admin-area:name'], area_roots: [NATIONWIDE] })
  })

  it('leaves out an undecided column, and one from before kinds were kept', () => {
    expect(
      vocabularySearchFields([
        vocabulary({
          places: ['131016'],
          roots: ['130001'],
          alternatives: [{ pack: 'XA', scheme: 'x', representation: 'c' }],
        }),
        vocabulary({ kind: undefined }),
        'not a vocabulary',
      ])
    ).toEqual({})
    expect(vocabularySearchFields(null)).toEqual({})
  })
})
