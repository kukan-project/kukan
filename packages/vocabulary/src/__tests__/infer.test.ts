import { describe, it, expect } from 'vitest'
import { createRegistry } from '../registry'
import { inferColumn, judgeColumn, matchValues } from '../infer'
import { JP_PACK } from '../packs/jp'

const registry = createRegistry([JP_PACK], '2026-11-14')
const best = (values: string[]) => inferColumn(registry, values)[0]

describe('inferColumn over the Japan pack', () => {
  it('takes 6-digit codes with their check digits for codes, needing no heading', () => {
    const prefectures = ['010006', '020001', '030007', '130001', '270008']
    expect(best(prefectures)).toMatchObject({
      concept: 'admin-area',
      pack: 'JP',
      scheme: 'jp-lg-code',
      representation: 'code6',
      share: 1,
      summary: { levels: [{ level: 'ADM1', matched: 5, total: 47 }], periods: [{}] },
    })
  })

  it('reads full-width digits as the code they spell', () => {
    expect(best(['０１０００６', '１３０００１'])).toMatchObject({ representation: 'code6' })
  })

  it('does not infer 5-digit codes from the column alone', () => {
    // Five digits are too common to be a code on their own say-so (ADR-073 §決定 5)
    expect(inferColumn(registry, ['01000', '13000', '27000'])).toEqual([])
    const fiveDigits = matchValues(registry, ['01000', '13000']).find((m) => m.rep.id === 'code5')
    expect(fiveDigits?.hits).toHaveLength(2)
  })

  it('takes names, short prefecture names and names qualified by their prefecture', () => {
    expect(best(['北海道', '東京', '大阪府', '沖縄県'])).toMatchObject({
      representation: 'name',
      share: 1,
    })
    expect(best(['北海道札幌市', '青森県弘前市', '福岡県福岡市'])).toMatchObject({
      representation: 'name',
      summary: { levels: [{ level: 'ADM2', matched: 3 }] },
    })
  })

  it('leaves names that are several places out of the share and the coverage', () => {
    // 府中市 is in Tokyo and in Hiroshima; 中央区 is a dozen wards
    const [m] = matchValues(registry, ['府中市', '中央区', '弘前市']).filter(
      (x) => x.rep.kind === 'name'
    )
    expect(m).toMatchObject({ values: 3, ambiguous: 2 })
    expect(m.hits.map((h) => h.code)).toEqual(['022021'])
  })

  it('keeps apart places in different prefectures that shared a name in turn', () => {
    // 大和町 in Saga was retired in 2005; 大和町 in Miyagi is current
    const [m] = matchValues(registry, ['大和町']).filter((x) => x.rep.kind === 'name')
    expect(m).toMatchObject({ ambiguous: 1, hits: [] })
  })

  it('takes a name a retired code shared for the current one', () => {
    // These cities kept their names when their codes changed on designation
    const cities = [
      '浜松市',
      'さいたま市',
      '新潟市',
      '静岡市',
      '岡山市',
      '相模原市',
      '熊本市',
      '堺市',
    ]
    expect(best(cities)).toMatchObject({ representation: 'name', share: 1, ambiguous: 0 })
  })

  it('does not date a column by a name in use under several codes', () => {
    // 浜松市 was 浜松市 before its code changed in 2007 as after
    expect(best(['浜松市', '静岡市', '沼津市'])?.summary.periods).toEqual([{}])
  })

  it('takes a ward written behind its prefecture and its city', () => {
    // 大阪府大阪市北区 and 大阪市北区 are one ward, counted once in the coverage
    expect(best(['大阪府大阪市北区', '北海道札幌市中央区', '大阪市北区'])).toMatchObject({
      representation: 'name',
      share: 1,
      summary: { levels: [{ level: 'ADM3', matched: 2 }] },
    })
  })

  it('leaves totals out of the count a share is taken over', () => {
    expect(best(['北海道', '青森県', '岩手県', '全国', '合計'])).toMatchObject({
      representation: 'name',
      share: 1,
    })
  })

  it('does not take a couple of surnames for prefectures', () => {
    expect(inferColumn(registry, ['山口', '石川'])).toEqual([])
  })

  it('counts a value once however it is spelled', () => {
    const [m] = matchValues(registry, ['010006', ' 010006', '０１０００６', 'abc']).filter(
      (x) => x.rep.id === 'code6'
    )
    expect(m).toMatchObject({ values: 2 })
    expect(m.hits).toHaveLength(1)
  })

  it('dates a column by a name that has since changed', () => {
    // 篠山市 became 丹波篠山市 on 2019-05-01, keeping its code
    expect(best(['篠山市', '神戸市', '姫路市'])?.summary).toMatchObject({
      periods: [{ validTo: '2019-05-01' }],
      narrowedBy: ['282219'],
    })
  })

  it('dates a column by the codes valid only in a period', () => {
    // 浜松市中区 was a ward from the city's designation in 2007 to the
    // reorganization of 2024-01-01, and the city's own code dates from 2007
    expect(best(['221317', '221309', '130001'])?.summary).toMatchObject({
      periods: [{ validFrom: '2007-04-01', validTo: '2024-01-01' }],
      narrowedBy: ['221317', '221309'],
    })
  })

  it('gives no period to codes from times that do not overlap', () => {
    // 浜松市中区 ended where 浜松市中央区 began
    expect(best(['221317', '221384'])?.summary.periods).toEqual([])
  })

  it('infers nothing with no pack enabled', () => {
    expect(inferColumn(createRegistry([]), ['010006', '北海道'])).toEqual([])
  })
})

describe('judgeColumn over the Japan pack', () => {
  const judge = (values: string[], heading: string, integer = false) =>
    judgeColumn(registry, values, { heading, integer })

  it('decides a column of codes', () => {
    expect(judge(['010006', '020001'], '団体コード')).toMatchObject({
      decided: { scheme: 'jp-lg-code', representation: 'code6', kind: 'code' },
    })
  })

  it('reads one integer down a column only under a heading naming a code', () => {
    // 202011 is a month, and checks out as a code all the same
    expect(judge(['202011'], '年月', true)).toBeNull()
    expect(judge(['131032'], '全国地方公共団体コード', true)).toMatchObject({
      decided: { representation: 'code6' },
    })
    // Text keeps its say: the standard sets write their one code as text
    expect(judge(['401307'], '識別子')).toMatchObject({ decided: { representation: 'code6' } })
  })

  it('reads no column past the most distinct values a column may have', () => {
    const many = Array.from({ length: 5_001 }, (_, i) => String(i))
    expect(judge(many, 'id')).toBeNull()
  })
})
