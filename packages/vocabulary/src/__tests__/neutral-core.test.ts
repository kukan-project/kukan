import { describe, it, expect } from 'vitest'
import { createRegistry, RULES_VERSION } from '../registry'
import { packVersion } from '../fingerprint'
import { inferColumn, judgeColumn, matchValues, summarizeCodes } from '../infer'
import { JP_PACK } from '../packs/jp'
import type { Pack } from '../types'

/**
 * A pack of no real country (XA is ISO's user-assigned range): codes with
 * letters and no check digit, names with spaces in English, a parent the code
 * does not spell. What the core does with it is what it does with any country
 * but Japan; a Japanese assumption in the core fails here first (ADR-073 §決定 8).
 */
const XA: Pack = {
  id: 'XA',
  version: 'test-1',
  correspondences: [],
  schemes: [
    {
      id: 'xa-region',
      concept: 'admin-area',
      label: { en: 'Region code (XA)' },
      publisher: 'Statistics Office of XA',
      license: { name: 'Open', url: 'https://example.org/licence', derivatives: true },
      source: { url: 'https://example.org/codes', retrieved: '2026-11-14' },
      codeFolding: ['nfkc', 'uppercase'],
      nameFolding: ['nfkc', 'lowercase'],
      representations: [
        { id: 'code', kind: 'code', pattern: '[A-Z]{2}\\d{3}' },
        { id: 'name', kind: 'name', qualified: { separator: ', ', order: 'child-first' } },
      ],
      codes: [
        {
          code: 'NR000',
          level: 'ADM1',
          names: [{ text: 'Northern Region', lang: 'en', kind: 'official' }],
        },
        {
          code: 'SR000',
          level: 'ADM1',
          names: [{ text: 'Southern Region', lang: 'en', kind: 'official' }],
        },
        {
          code: 'KT101',
          level: 'ADM2',
          parent: 'NR000',
          names: [{ text: 'North Harbor', lang: 'en', kind: 'official' }],
        },
        {
          code: 'KT102',
          level: 'ADM2',
          parent: 'SR000',
          validTo: '2020-01-01',
          names: [{ text: 'Old Mill', lang: 'en', kind: 'official' }],
        },
      ],
    },
  ],
}

describe('a pack of no real country', () => {
  const registry = createRegistry([XA], '2026-11-14')

  it('matches codes with letters, folded by the scheme, but infers none without a check digit', () => {
    const [codes] = matchValues(registry, ['NR000', 'kt101'])
    expect(codes.rep.kind).toBe('code')
    expect(codes.hits.map((h) => h.code)).toEqual(['NR000', 'KT101'])
    expect(inferColumn(registry, ['NR000', 'KT101'])).toEqual([])
  })

  it('matches names with spaces, folded by the scheme, and qualified its own way', () => {
    expect(
      inferColumn(registry, ['northern region', 'NORTH HARBOR', 'North Harbor, Northern Region'])[0]
    ).toMatchObject({
      pack: 'XA',
      scheme: 'xa-region',
      representation: 'name',
      share: 1,
    })
  })

  it('counts coverage against the entries valid on the day', () => {
    const [regions] = matchValues(registry, ['Northern Region', 'Southern Region']).filter(
      (m) => m.rep.kind === 'name'
    )
    expect(summarizeCodes(regions.scheme, regions.hits).levels).toEqual([
      { level: 'ADM1', matched: 2, total: 2 },
    ])
    const [old] = matchValues(registry, ['Old Mill']).filter((m) => m.rep.kind === 'name')
    expect(summarizeCodes(old.scheme, old.hits).periods).toEqual([{ validTo: '2020-01-01' }])
  })
})

describe('the registry state', () => {
  it('names the rules and every enabled pack, whatever order they come in', () => {
    const a = createRegistry([XA, JP_PACK]).state
    expect(a).toBe(createRegistry([JP_PACK, XA]).state)
    expect(a).toBe(`rules@${RULES_VERSION};JP@${JP_PACK.version};XA@test-1`)
  })

  it('changes a pack’s version with what its schemes say, not only with its tables', () => {
    const [scheme] = XA.schemes
    const base = packVersion('t1', [scheme])
    expect(packVersion('t1', [{ ...scheme, notAreas: ['Total'] }])).not.toBe(base)
    expect(packVersion('t1', [{ ...scheme, codes: [] }])).toBe(base)
  })

  it('refuses a pack enabled twice', () => {
    expect(() => createRegistry([XA, XA])).toThrow(/twice/)
  })

  it('refuses a scheme naming two representations alike', () => {
    const [scheme] = XA.schemes
    const twice = {
      ...XA,
      schemes: [
        { ...scheme, representations: [...scheme.representations, scheme.representations[0]] },
      ],
    }
    expect(() => createRegistry([twice])).toThrow(/twice/)
  })
})

describe('periods over a pack of no real country', () => {
  const code = (c: string, level: 'ADM1' | 'ADM2', name: string, extra = {}) => ({
    code: c,
    level,
    names: [{ text: name, lang: 'en', kind: 'official' as const }],
    ...extra,
  })
  const XB: Pack = {
    ...XA,
    id: 'XB',
    schemes: [
      {
        ...XA.schemes[0],
        id: 'xb-area',
        codes: [
          // Retired in 2010 and given out again in 2020
          code('RU001', 'ADM1', 'Reed', { validTo: '2010-01-01' }),
          code('RU001', 'ADM1', 'Rush', { validFrom: '2020-01-01' }),
          code('TM001', 'ADM1', 'Brief', { validFrom: '2015-01-01', validTo: '2016-01-01' }),
          // A county renamed in 2020, and a town in it
          {
            code: 'CO001',
            level: 'ADM1',
            names: [
              { text: 'Old County', lang: 'en', kind: 'official', validTo: '2020-01-01' },
              { text: 'New County', lang: 'en', kind: 'official', validFrom: '2020-01-01' },
            ],
          },
          code('AT001', 'ADM2', 'Ash Town', { parent: 'CO001' }),
          // A district retired in 2010 and its code given to another in 2020;
          // a town under the earlier one, from 2001 to 2009
          code('DI001', 'ADM1', 'Elm District', { validTo: '2010-01-01' }),
          code('DI001', 'ADM1', 'Oak District', { validFrom: '2020-01-01' }),
          code('BT001', 'ADM2', 'Birch Town', {
            parent: 'DI001',
            validFrom: '2001-01-01',
            validTo: '2009-01-01',
          }),
          // A town code under one region until 2010, given out under another
          // from 2020; a quarter of the later town
          code('NA000', 'ADM1', 'North Region'),
          code('SO000', 'ADM1', 'South Region'),
          code('MT001', 'ADM2', 'Mid Town', { parent: 'NA000', validTo: '2010-01-01' }),
          code('MT001', 'ADM2', 'Mid Town', { parent: 'SO000', validFrom: '2020-01-01' }),
          {
            ...code('CQ001', 'ADM2', 'Central Quarter', {
              parent: 'MT001',
              validFrom: '2020-01-01',
            }),
            level: 'ADM3',
          },
          // A city that moved from one region to the other in 2010, and a ward of it
          code('RC001', 'ADM2', 'River City', { parent: 'NA000', validTo: '2010-01-01' }),
          code('RC001', 'ADM2', 'River City', { parent: 'SO000', validFrom: '2010-01-01' }),
          { ...code('WD001', 'ADM2', 'Harbor Ward', { parent: 'RC001' }), level: 'ADM3' },
        ],
      },
    ],
  }
  const registry = createRegistry([XB], '2026-11-14')
  const summary = (values: string[], kind: 'code' | 'name') => {
    const [m] = matchValues(registry, values).filter((x) => x.rep.kind === kind)
    return summarizeCodes(m.scheme, m.hits)
  }

  it('does not take a reused code for valid between its uses', () => {
    // RU001 was in use before 2010 and after 2020; TM001 only in 2015
    expect(summary(['RU001', 'TM001'], 'code').periods).toEqual([])
    // The gap between its uses stays out of the column's periods
    expect(summary(['RU001'], 'code').periods).toEqual([
      { validTo: '2010-01-01' },
      { validFrom: '2020-01-01' },
    ])
  })

  it('qualifies a name by its parent’s earlier use when the parent’s code was reused', () => {
    expect(summary(['Birch Town, Elm District'], 'name').periods).toEqual([
      { validFrom: '2001-01-01', validTo: '2009-01-01' },
    ])
  })

  it('follows a reused parent code up to the grandparent of the use it was under', () => {
    expect(summary(['Central Quarter, Mid Town, South Region'], 'name').periods).toEqual([
      { validFrom: '2020-01-01' },
    ])
    const [wrong] = matchValues(registry, ['Central Quarter, Mid Town, North Region']).filter(
      (x) => x.rep.kind === 'name'
    )
    expect(wrong.hits).toEqual([])
  })

  it('bounds a name by an ancestor it leaves out', () => {
    // The ward under the region, the city left out: still only while the city was there
    expect(summary(['Harbor Ward, North Region'], 'name').periods).toEqual([
      { validTo: '2010-01-01' },
    ])
    expect(summary(['Harbor Ward, South Region'], 'name').periods).toEqual([
      { validFrom: '2010-01-01' },
    ])
  })

  it('qualifies a name by its parent’s former names, only while both were in use', () => {
    expect(summary(['Ash Town, Old County'], 'name').periods).toEqual([{ validTo: '2020-01-01' }])
    expect(summary(['Ash Town, New County'], 'name').periods).toEqual([{ validFrom: '2020-01-01' }])
  })
})

describe('a column two schemes fit', () => {
  // Another region's scheme naming the same places
  const XC: Pack = {
    ...XA,
    id: 'XC',
    schemes: [{ ...XA.schemes[0], id: 'xc-region' }],
  }

  it('is left undecided, with every scheme that fits as a candidate', () => {
    const verdict = judgeColumn(
      createRegistry([XA, XC], '2026-11-14'),
      ['Northern Region', 'Southern Region', 'North Harbor'],
      { heading: 'region', integer: false }
    )
    expect(verdict && 'candidates' in verdict && verdict.candidates.map((c) => c.scheme)).toEqual([
      'xa-region',
      'xc-region',
    ])
  })
})
