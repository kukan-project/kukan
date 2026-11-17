import { describe, it, expect } from 'vitest'
import { canonicalPlace, createRegistry, placeName, placeRoots } from '../registry'
import { corroborate, inferColumn, judgeColumn, judgeNamesByCodes, matchValues } from '../infer'
import { JP_PACK } from '../packs/jp'

const registry = createRegistry([JP_PACK], '2026-11-14')
const best = (values: string[]) => inferColumn(registry, values)[0]
const TOKYO_WARDS = Array.from({ length: 23 }, (_, i) => String(13101 + i))

describe('inferColumn over the Japan pack', () => {
  it('takes 6-digit codes with their check digits for codes, needing no heading', () => {
    const prefectures = ['010006', '020001', '030007', '130001', '270008']
    expect(best(prefectures)).toMatchObject({
      concept: 'admin-area',
      pack: 'JP',
      scheme: 'jp-area-code',
      representation: 'code6',
      share: 1,
      summary: { levels: [{ level: 'ADM1', matched: 5, total: 47 }], periods: [{}] },
    })
  })

  it('records the places matched and the top-level places they lie in', () => {
    expect(best(['131016', '131024', '271004', '011002'])).toMatchObject({
      places: ['011002', '131016', '131024', '271004'],
      roots: ['010006', '130001', '270008'],
    })
    // A prefecture is its own top
    expect(best(['010006', '130001'])).toMatchObject({
      places: ['010006', '130001'],
      roots: ['010006', '130001'],
    })
  })

  it('reads full-width digits as the code they spell', () => {
    expect(best(['０１０００６', '１３０００１'])).toMatchObject({ representation: 'code6' })
  })

  it('takes 5-digit codes on their own say-so only when many and in several prefectures', () => {
    // Five digits are too common to be a code on their own say-so (ADR-073 §決定 5)
    expect(best(['01000', '13000', '27000'])).toMatchObject({
      representation: 'code5',
      standsAlone: false,
    })
    // Every ward of Tokyo is also a run numbered from 13101
    expect(best(TOKYO_WARDS.slice(0, 20))).toMatchObject({ standsAlone: false })
    expect(best([...TOKYO_WARDS.slice(0, 20), '27100'])).toMatchObject({
      representation: 'code5',
      standsAlone: true,
    })
    // Under one prefecture it takes more than any serial number can match
    const hokkaido = JP_PACK.schemes[0].codes
      .filter((e) => e.code.startsWith('01') && e.level !== 'ADM1' && !e.validTo)
      .map((e) => e.code.slice(0, 5))
    expect(best(hokkaido.slice(0, 49))).toMatchObject({ standsAlone: false })
    expect(best(hokkaido.slice(0, 50))).toMatchObject({ standsAlone: true })
    const fiveDigits = matchValues(registry, ['01000', '13000']).find((m) => m.rep.id === 'code5')
    expect(fiveDigits?.hits).toHaveLength(2)
  })

  it('reads two digits as the prefecture whose code they start', () => {
    expect(best(['01', '13', '47'])).toMatchObject({
      representation: 'pref2',
      standsAlone: false,
      summary: { levels: [{ level: 'ADM1', matched: 3, total: 47 }] },
    })
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

  it('reads a name written with a variant of the code table’s character', () => {
    // The code table writes 檮原町, 檜原村 and 鰺ヶ沢町
    expect(best(['梼原町', '桧原村', '鯵ヶ沢町'])).toMatchObject({
      representation: 'name',
      share: 1,
      places: ['023213', '133078', '394050'],
    })
  })

  it('leaves the ward area out of a column of names, written after Tokyo too', () => {
    const [found] = inferColumn(registry, ['東京都特別区部', '千代田区', '新宿区', '文京区'])
    expect(found).toMatchObject({ representation: 'name', share: 1 })
    expect(found.places).not.toContain('131008')
  })

  it('does not read English or kana names as a column of names', () => {
    expect(best(['Tokyo Metropolis', 'Osaka Prefecture', 'Hokkaido Prefecture'])).toBeUndefined()
    expect(best(['トウキョウト', 'オオサカフ', 'ホッカイドウ'])).toBeUndefined()
  })

  it('leaves names that are several places out of the share and the coverage', () => {
    // 府中市 is in Tokyo and in Hiroshima; 中央区 is a dozen wards
    const [m] = matchValues(registry, ['府中市', '中央区', '弘前市']).filter(
      (x) => x.rep.kind === 'name'
    )
    expect(m).toMatchObject({ values: 3, ambiguous: 2 })
    expect(m.hits.map((h) => h.code)).toEqual(['022021'])
  })

  it('takes the share over the names that name one place or none', () => {
    // Two of four name several places: the other two decide it
    expect(best(['府中市', '中央区', '弘前市', '八王子市', '立川市'])).toMatchObject({
      representation: 'name',
      share: 1,
      ambiguous: 2,
    })
    // Every one of them a name several places share: nothing to go by
    expect(best(['中央区', '北区', '南区'])).toBeUndefined()
    // Town names cities share, and three that happen to be one place's: not enough
    const towns = [
      '栄町',
      '旭町',
      '錦町',
      '朝日町',
      '新町',
      '中町',
      '東町',
      '清水町',
      '大和町',
      '吉田町',
    ]
    expect(best(towns)).toBeUndefined()
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

  it('leaves out the groups a prefecture’s statistics put among its municipalities', () => {
    // Tokyo's population table: its wards and towns, and the groups between them
    const names = ['総数', '区部', '千代田区', '新宿区', '文京区', '市部', '八王子市', '郡部']
    const tail = ['瑞穂町', '島部', '大島支庁', '利島村', '町村部']
    expect(best([...names, ...tail])).toMatchObject({ representation: 'name', share: 1 })
    // Hokkaido's subprefectures, by the same token
    expect(best(['石狩振興局', '札幌市', '江別市', '千歳市'])).toMatchObject({ share: 1 })
    // Saitama's totals and counties, Osaka's regions, Fukuoka's areas
    const saitama = ['埼玉県　市計', '町村計', '北足立郡', '入間郡', '川越市', '熊谷市', '川口市']
    expect(best(saitama)).toMatchObject({ representation: 'name', share: 1 })
    const osaka = ['大阪市地域', '北大阪地域', '北九州市圏域', '堺市', '岸和田市', '豊中市']
    expect(best(osaka)).toMatchObject({ representation: 'name', share: 1 })
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
      decided: { scheme: 'jp-area-code', representation: 'code6', kind: 'code' },
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

  it('leaves short codes unconfirmed, unless the heading names how they are written', () => {
    // The days of a month are prefecture codes as far as their values go
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
    expect(judge(days, '日')).toMatchObject({ unconfirmed: [{ representation: 'pref2' }] })
    expect(judge(['01', '13', '47'], '都道府県コード')).toMatchObject({
      decided: { representation: 'pref2', standsAlone: true },
    })
    // `コード` heads any column of codes, and is no evidence of these
    expect(judge(['01', '13', '47'], 'コード')).toHaveProperty('unconfirmed')
    expect(judge(['13101'], '市区町村コード')).toMatchObject({
      decided: { representation: 'code5' },
    })
  })

  it('leaves codes short of their share by a statistics table’s groups for names to bear out', () => {
    // 13200 市部 and 13550 町村部 are Tokyo's own, in no code table
    const codes = [
      '13550',
      '13101',
      '13104',
      '13105',
      '13200',
      '13201',
      '13202',
      '13203',
      '13204',
      '13205',
    ]
    expect(judge(codes, '地域コード')).toMatchObject({
      unconfirmed: [
        { representation: 'code5', share: 0.8, shortOfShare: true, standsAlone: false },
      ],
    })
    // A heading does not stand in for the names that say the rest are groups
    expect(judge(codes, '市区町村コード')).toHaveProperty('unconfirmed')
    // Below that, nothing
    expect(judge([...codes, '13300', '13350'], '地域コード')).toBeNull()
  })

  it('counts the standard area code’s groups as places, but not toward a level', () => {
    // 13100 特別区部 is a group of the standard area code's, as a county is
    const codes = ['13100', '13101', '13102', '13103', '02300', '02301']
    const [found] = inferColumn(registry, codes)
    expect(found).toMatchObject({ representation: 'code5', share: 1, shortOfShare: false })
    // Groups are in no tree, so no place to search by, but say the prefecture
    expect(found.places).toEqual(['023019', '131016', '131024', '131032'])
    expect(found.roots).toEqual(['020001', '130001'])
    expect(found.summary.levels).toEqual([{ level: 'ADM2', matched: 4, total: expect.any(Number) }])
  })

  it('reads no column past the most distinct values a column may have', () => {
    const many = Array.from({ length: 5_001 }, (_, i) => String(i))
    expect(judge(many, 'id')).toBeNull()
  })
})

describe('corroborate over the Japan pack', () => {
  const [pref2] = inferColumn(registry, ['01', '13', '47'])

  it('takes codes the names beside them agree with', () => {
    const pairs: [string, string][] = [
      ['01', '北海道'],
      ['13', '東京都'],
      ['47', '沖縄'],
      // A total, and a name of no one place, leave the count alone
      ['00', '全国'],
      ['13', '府中市'],
    ]
    expect(corroborate(registry, pref2, pairs)).toBe(true)
  })

  it('refuses codes the names beside them disagree with', () => {
    // A rank beside the prefecture it ranks
    const ranks: [string, string][] = [
      ['01', '東京都'],
      ['02', '神奈川県'],
      ['03', '大阪府'],
      ['04', '愛知県'],
    ]
    expect(corroborate(registry, pref2, ranks)).toBe(false)
  })

  it('takes a prefecture’s code beside the names of its cities', () => {
    const cities: [string, string][] = [
      ['01', '札幌市'],
      ['01', '函館市'],
      ['13', '八王子市'],
      ['27', '堺市'],
    ]
    expect(corroborate(registry, pref2, cities)).toBe(true)
  })

  it('refuses one value down a table of one prefecture’s cities', () => {
    // A category written `01` sits under every city of Hokkaido
    const kinds: [string, string][] = [
      ['01', '札幌市'],
      ['01', '函館市'],
      ['01', '小樽市'],
      ['01', '旭川市'],
    ]
    expect(corroborate(registry, pref2, kinds)).toBe(false)
  })

  it('takes a code from before the place was renumbered', () => {
    const [code5] = inferColumn(registry, ['22202', '15201', '33201'])
    const before: [string, string][] = [
      ['22202', '浜松市'],
      ['15201', '新潟市'],
      ['33201', '岡山市'],
    ]
    expect(corroborate(registry, code5, before)).toBe(true)
  })

  it('bears out codes short of their share, the names beside the groups being no place', () => {
    const rows: [string, string][] = [
      ['13550', '町村部'],
      ['13101', '千代田区'],
      ['13104', '新宿区'],
      ['13105', '文京区'],
      ['13200', '市部'],
      ['13201', '八王子市'],
      ['13202', '立川市'],
      ['13203', '武蔵野市'],
      ['13204', '三鷹市'],
      ['13205', '青梅市'],
    ]
    const [short] = inferColumn(
      registry,
      rows.map(([code]) => code)
    )
    expect(short).toMatchObject({ representation: 'code5', shortOfShare: true })
    expect(corroborate(registry, short, rows)).toBe(true)
  })

  it('wants a few rows to agree on', () => {
    expect(
      corroborate(registry, pref2, [
        ['13', '東京都'],
        ['27', '大阪府'],
      ])
    ).toBe(false)
  })
})

describe('judgeNamesByCodes over the Japan pack', () => {
  // Names every one of which several places share: Tokyo's, by the codes beside them
  const rows: [string, string][] = [
    ['13102', '中央区'],
    ['13103', '港区'],
    ['13117', '北区'],
    ['13206', '府中市'],
    ['13100', '区部'],
  ]
  const [codes] = inferColumn(
    registry,
    rows.map(([code]) => code)
  )

  it('reads a name several places share as the one its row’s code names', () => {
    expect(best(rows.map(([, name]) => name))).toBeUndefined()
    expect(judgeNamesByCodes(registry, codes, rows)).toMatchObject({
      representation: 'name',
      share: 1,
      ambiguous: 0,
      summary: { levels: [{ level: 'ADM2', matched: 4 }] },
    })
  })

  it('takes a prefecture’s code beside them for where they lie', () => {
    const [pref] = inferColumn(registry, ['13', '27', '01'])
    const byPrefecture: [string, string][] = [
      ['13', '中央区'],
      ['27', '中央区'],
      ['01', '中央区'],
      ['13', '港区'],
      ['13', '北区'],
    ]
    expect(judgeNamesByCodes(registry, pref, byPrefecture)).toMatchObject({ ambiguous: 0 })
  })

  it('leaves a name its row’s code does not narrow to one place undecided', () => {
    // 北区 is a ward of Osaka and of Sakai, both in 27
    const [pref] = inferColumn(registry, ['13', '27', '01'])
    const wide: [string, string][] = [
      ['27', '北区'],
      ['13', '中央区'],
      ['13', '港区'],
      ['13', '新宿区'],
      ['01', '札幌市'],
    ]
    expect(judgeNamesByCodes(registry, pref, wide)).toMatchObject({ ambiguous: 1, share: 0.8 })
  })

  it('leaves the names unread where the codes do not pick among them', () => {
    const wrong: [string, string][] = [
      ['01101', '中央区'],
      ['01102', '港区'],
      ['01103', '北区'],
    ]
    const [other] = inferColumn(registry, ['01101', '01102', '01103'])
    expect(judgeNamesByCodes(registry, other, wrong)).toBeNull()
  })

  it('counts the names on rows with no code, as a column of names alone would', () => {
    // Three wards coded, then parks on rows with no code: no column of names
    const parks = ['公園', '広場', '緑地', '霊園', '運動場'].map((n): [null, string] => [null, n])
    expect(judgeNamesByCodes(registry, codes, [...rows.slice(0, 3), ...parks])).toBeNull()
  })

  it('counts every place a shared name is in one table', () => {
    const both: [string, string][] = [
      ['13102', '中央区'],
      ['27128', '中央区'],
      ['13103', '港区'],
      ['13117', '北区'],
    ]
    const [mixed] = inferColumn(
      registry,
      both.map(([code]) => code)
    )
    expect(judgeNamesByCodes(registry, mixed, both)?.summary.levels).toEqual([
      { level: 'ADM2', matched: 3, total: 1747 },
      { level: 'ADM3', matched: 1, total: 171 },
    ])
  })

  it('counts the names several places share in corroborating the codes', () => {
    expect(corroborate(registry, codes, rows)).toBe(true)
  })
})

describe('places by code', () => {
  it('reads a place however a request writes its code', () => {
    expect(canonicalPlace(registry, '13')).toBe('130001')
    expect(canonicalPlace(registry, '130001')).toBe('130001')
    expect(canonicalPlace(registry, '13101')).toBe('131016')
    expect(canonicalPlace(registry, '99')).toBeNull()
  })

  it('names a place, and finds the top-level places it lies in', () => {
    expect(placeName(registry, '130001')).toBe('東京都')
    expect(placeRoots(registry, '011011')).toEqual(['010006'])
    // A prefecture is its own top
    expect(placeRoots(registry, '130001')).toEqual(['130001'])
    expect(placeRoots(registry, 'XX')).toEqual([])
  })
})
