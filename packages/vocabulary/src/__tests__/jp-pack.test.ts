import { describe, it, expect } from 'vitest'
import { fold, foldName, hasValidCheckDigit } from '../fold'
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

  it('holds the standard area code’s groups apart from the levels, named by the areas they group', () => {
    const groups = scheme.codes.filter((e) => e.group)
    expect(groups.filter((e) => e.level !== undefined)).toEqual([])
    expect(groups).toHaveLength(326)
    // A group's parent is its prefecture; an area keeps its own parent and names its group
    expect(byCode('023001')).toMatchObject([{ group: '郡', parent: '020001' }])
    expect(byCode('023019')).toMatchObject([
      { level: 'ADM2', parent: '020001', groups: ['023001'] },
    ])
    expect(byCode('131016')).toMatchObject([{ parent: '130001', groups: ['131008'] }])
    // A town of Hokkaido is in a bureau, not a county of the standard area code
    expect(byCode('013030')).toMatchObject([{ parent: '010006', groups: ['013005'] }])
    const codes = new Set(scheme.codes.map((e) => e.code))
    expect(scheme.codes.flatMap((e) => e.groups ?? []).filter((g) => !codes.has(g))).toEqual([])
  })

  it('names each current entry in Japanese, in kana and in English', () => {
    const current = scheme.codes.filter((e) => e.validTo === undefined)
    const langs = (e: (typeof current)[number]) =>
      [...new Set(e.names.filter((n) => n.kind === 'official').map((n) => n.lang))].sort()
    expect(current.filter((e) => langs(e).join() !== 'en,ja,ja-Hrkt')).toEqual([])
  })

  it('joins no two places’ names by its variant characters', () => {
    // A name folded with the variants stands for the places it stood for without them
    const places = new Map<string, Set<string>>()
    for (const e of scheme.codes) {
      for (const n of e.names.filter((n) => n.lang === 'ja')) {
        const key = foldName(scheme, n.text)
        const plain = fold(scheme.nameFolding, n.text)
        places.set(key, (places.get(key) ?? new Set()).add(plain))
      }
    }
    expect([...places].filter(([, plain]) => plain.size > 1)).toEqual([])
  })

  it('writes English names as the GSI’s rules for English place names do', () => {
    const english = (code: string) =>
      byCode(code)
        .at(-1)!
        .names.find((n) => n.lang === 'en')!.text
    expect(english('130001')).toBe('Tokyo Metropolis')
    expect(english('010006')).toBe('Hokkaido Prefecture')
    expect(english('100005')).toBe('Gunma Prefecture')
    expect(english('131016')).toBe('Chiyoda City')
    expect(english('011011')).toBe('Chuo Ward')
    expect(english('372056')).toBe('Kan-onji City')
    expect(english('023001')).toBe('Higashitsugaru County')
    expect(english('013005')).toBe('Ishikari Subprefecture')
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
    // and its reading and English name start with it
    expect(byCode('282219')[0].names).toEqual([
      { text: '丹波篠山市', lang: 'ja', kind: 'official', validFrom: '2019-05-01' },
      { text: 'タンバササヤマシ', lang: 'ja-Hrkt', kind: 'official', validFrom: '2019-05-01' },
      { text: 'Tanbasasayama City', lang: 'en', kind: 'official', validFrom: '2019-05-01' },
      { text: '篠山市', lang: 'ja', kind: 'official', validTo: '2019-05-01' },
    ])
    expect(byCode('124028')).toMatchObject([{ validTo: '2013-01-01' }])
  })
})
