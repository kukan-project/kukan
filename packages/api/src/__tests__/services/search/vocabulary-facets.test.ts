import { describe, it, expect } from 'vitest'
import { createRegistry } from '@kukan/vocabulary'
import { JP_PACK } from '@kukan/vocabulary/packs/jp'
import { canonicalAreas, nameVocabularyFacets } from '../../../services/search/vocabulary-facets'

const registry = createRegistry([JP_PACK], '2026-11-16')

describe('canonicalAreas', () => {
  it('takes any spelling of a place to its canonical code, nationwide as it is', () => {
    expect(canonicalAreas(registry, ['13', '130001', '*', 'nowhere'])).toEqual([
      '130001',
      '*',
      'nowhere',
    ])
    expect(canonicalAreas(registry, [])).toBeUndefined()
  })
})

describe('nameVocabularyFacets', () => {
  const facets = {
    areas: [
      { name: '130001', count: 2 },
      { name: '*', count: 1 },
    ],
    // Osaka's ward came from a dataset that holds Tokyo too
    areaPlaces: [
      { name: '131016', count: 2 },
      { name: '271004', count: 1 },
    ],
    meanings: [{ name: 'admin-area:code', count: 2 }],
  }

  it('names the areas, and keeps the places to those under the areas asked for', () => {
    expect(nameVocabularyFacets(facets, registry, { areas: ['130001'] })).toEqual({
      areas: [
        { name: '130001', count: 2, title: '東京都' },
        { name: '*', count: 1, title: null },
      ],
      areaPlaces: [{ name: '131016', count: 2, title: '千代田区', parent: '130001' }],
      meanings: facets.meanings,
    })
  })

  it('keeps an area and a meaning asked for on the screen though nothing holds them now', () => {
    const named = nameVocabularyFacets({ areas: [], areaPlaces: [], meanings: [] }, registry, {
      areas: ['130001'],
      meanings: ['admin-area:name'],
    })
    expect(named.areas).toEqual([{ name: '130001', count: 0, title: '東京都' }])
    expect(named.meanings).toEqual([{ name: 'admin-area:name', count: 0 }])
  })

  it('keeps a place asked for on the screen though nothing holds it now', () => {
    const named = nameVocabularyFacets(facets, registry, { places: ['131024'] })
    expect(named.areaPlaces).toEqual([
      { name: '131024', count: 0, title: '中央区', parent: '130001' },
    ])
  })
})
