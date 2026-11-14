import { describe, it, expect } from 'vitest'
import { hasValidCheckDigit } from '../fold'
import { JP_PACK } from '../packs/jp'

const [scheme] = JP_PACK.schemes
const byCode = (code: string) => scheme.codes.filter((e) => e.code === code)

/** The generated table, held to what a scheme's data has to be (`scripts/build-jp-pack.ts`). */
describe('the Japan pack', () => {
  it('holds codes whose check digits hold', () => {
    const bad = scheme.codes.filter((e) => !hasValidCheckDigit('mod11-weights-6-2', e.code))
    expect(bad).toEqual([])
  })

  it('holds the 47 prefectures, and a current entry for each code at most once', () => {
    const current = scheme.codes.filter((e) => e.validTo === undefined)
    expect(current.filter((e) => e.level === 'ADM1')).toHaveLength(47)
    expect(new Set(current.map((e) => e.code)).size).toBe(current.length)
  })

  it('has periods that end after they start', () => {
    const wrong = [...scheme.codes, ...scheme.codes.flatMap((e) => e.names)].filter(
      (p) => p.validFrom !== undefined && p.validTo !== undefined && p.validFrom >= p.validTo
    )
    expect(wrong).toEqual([])
  })

  it('gives every entry below the top a parent the table holds', () => {
    const codes = new Set(scheme.codes.map((e) => e.code))
    expect(scheme.codes.filter((e) => e.level !== 'ADM1' && !codes.has(e.parent!))).toEqual([])
  })

  it('reads a ward reorganization, a renaming and a retirement off the change list', () => {
    // 浜松市 reorganized its wards on 2024-01-01
    expect(byCode('221317')).toMatchObject([
      { level: 'ADM3', parent: '221309', validFrom: '2007-04-01', validTo: '2024-01-01' },
    ])
    // A ward is held by its own name; the registry writes it behind its city
    expect(byCode('221317')[0].names.map((n) => n.text)).toEqual(['中区'])
    expect(byCode('221384')).toMatchObject([{ validFrom: '2024-01-01' }])
    // 篠山市 became 丹波篠山市, keeping its code
    expect(byCode('282219')[0].names).toEqual([
      { text: '丹波篠山市', lang: 'ja', kind: 'official', validFrom: '2019-05-01' },
      { text: '篠山市', lang: 'ja', kind: 'official', validTo: '2019-05-01' },
    ])
    expect(byCode('124028')).toMatchObject([{ validTo: '2013-01-01' }])
  })
})
