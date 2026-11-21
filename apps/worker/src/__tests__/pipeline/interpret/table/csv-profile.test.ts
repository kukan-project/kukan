import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COLUMN_VALUES_KEPT,
  TABLE_SENTENCES_MAX_BYTES,
  type ColumnProfile,
  type OverridableColumnRole,
  type TableProfileLine,
} from '@kukan/shared'
import { interpretCsv } from '@/pipeline/interpret/table/csv'

/**
 * Column roles (ADR-063), counted by DuckDB over a real interpretation — the
 * regexes are RE2 inside SQL, so a test of the rules alone would not reach them.
 */
describe('interpretCsv — column roles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-profile-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Each column's profile, by heading. */
  async function columns(
    header: string[],
    rows: string[][],
    roleOverrides?: Record<string, OverridableColumnRole>
  ): Promise<Record<string, ColumnProfile>> {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, [header, ...rows].map((r) => r.join(',')).join('\n') + '\n')
    const { schema, profile } = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0, {
      path: join(dir, 'profile.ndjson.zst'),
      vocabularyPacks: [],
      ...(roleOverrides && { roleOverrides }),
    })
    return Object.fromEntries(schema.columns.map((c, i) => [c.name, profile!.columns[i]]))
  }

  const CITIES = ['青森市', '弘前市', '八戸市']
  const rows = Array.from({ length: 40 }, (_, i) => [
    CITIES[i % 3],
    `市立第${i + 1}保育園`,
    i % 5 === 0 ? '-' : i % 7 === 0 ? '"1,000"' : `${i}`,
    '017-734-1111',
    i % 2 === 0 ? 'ありません。' : '駐車場は、正面にあります。',
    `https://example.jp/f/${i}`,
    `令和${(i % 6) + 1}年4月`,
    '',
    `A${String(i).padStart(3, '0')}`,
    `${i * 10}`,
  ])
  const header = [
    '市区町村名',
    '施設名',
    '定員',
    '電話番号',
    '特記事項',
    'URL',
    '開設',
    '空き',
    '施設コード',
    '面積',
  ]

  it('gives each column the role its values show', async () => {
    const cols = await columns(header, rows)
    expect(Object.fromEntries(Object.entries(cols).map(([n, c]) => [n, c.role]))).toEqual({
      市区町村名: 'category',
      施設名: 'name',
      定員: 'numeric-text',
      電話番号: 'identifier',
      特記事項: 'free-text',
      URL: 'identifier',
      開設: 'measure',
      空き: 'empty',
      施設コード: 'identifier',
      面積: 'measure',
    })
    expect(cols['面積'].roleBasis).toEqual({ rule: 'typed' })
    expect(cols['電話番号'].roleBasis).toEqual({ rule: 'phone-shape', share: 1 })
    expect(cols['開設'].roleBasis).toEqual({ rule: 'date-shape', share: 1 })
  })

  it("takes a person's role over the rules', and lists values by the role it ends with", async () => {
    const cols = await columns(header, rows, {
      施設名: 'identifier',
      施設コード: 'category',
      // A column the table typed keeps its type's role, and a gone one is ignored
      面積: 'category',
      無い列: 'name',
    })
    expect(cols['施設名']).toMatchObject({
      role: 'identifier',
      roleBasis: { rule: 'override' },
      inferred: { role: 'name', roleBasis: { rule: expect.any(String) } },
    })
    expect(cols['施設名'].values).toBeUndefined()
    expect(cols['施設コード']).toMatchObject({ role: 'category', inferred: { role: 'identifier' } })
    expect(cols['施設コード'].values).toContain('A000')
    expect(cols['面積']).toEqual({ role: 'measure', roleBasis: { rule: 'typed' } })
    // Untouched columns carry no trace of the override
    expect(cols['市区町村名'].inferred).toBeUndefined()
  })

  it("reads only a setting's own keys, whatever a column is called", async () => {
    const cols = await columns(
      ['constructor', 'toString'],
      [
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ],
      // A record, as the setting is: an object literal's `toString` is typed as the method
      Object.fromEntries([['toString', 'free-text']]) as Record<string, OverridableColumnRole>
    )
    expect(cols['constructor'].roleBasis.rule).not.toBe('override')
    expect(typeof cols['constructor'].role).toBe('string')
    expect(cols['toString']).toMatchObject({ role: 'free-text', roleBasis: { rule: 'override' } })
  })

  it('records no override where it names the role the rules gave', async () => {
    const cols = await columns(header, rows, { 市区町村名: 'category' })
    expect(cols['市区町村名'].roleBasis.rule).not.toBe('override')
    expect(cols['市区町村名'].inferred).toBeUndefined()
  })

  it('names what keeps a number written as text from being one', async () => {
    const cols = await columns(header, rows)
    expect(cols['定員'].roleBasis).toEqual({
      rule: 'number-shape',
      share: 1,
      examples: ['-', '1,000'],
    })
  })

  it('lists the values of names and categories, most frequent first', async () => {
    const cols = await columns(header, rows)
    // 青森市 takes rows 1, 4, … — one more than the others, which tie and come
    // in the order they first appear
    expect(cols['市区町村名'].values).toEqual(['青森市', '弘前市', '八戸市'])
    expect(cols['施設名'].values).toHaveLength(COLUMN_VALUES_KEPT)
    expect(cols['施設名'].values!.slice(0, 2)).toEqual(['市立第1保育園', '市立第2保育園'])
    // Only the two roles a search finds a table by its values in
    expect(cols['特記事項'].values).toBeUndefined()
    expect(cols['施設コード'].values).toBeUndefined()
  })

  it('reads dates written with dots or in abbreviated eras as dates, not numbers', async () => {
    // One `-` keeps the column text, as it does in published tables; the
    // number shape takes both the dates and the dash, so the order decides
    const cols = await columns(
      ['公表日', '施行日', '金額'],
      Array.from({ length: 20 }, (_, i) => [
        i === 0 ? '-' : `2024.${(i % 12) + 1}.1`,
        i === 0 ? '-' : `H31.${(i % 12) + 1}.1`,
        i === 0 ? '-' : `1234.5${i % 10}`,
      ])
    )
    expect(cols['公表日'].roleBasis).toEqual({ rule: 'date-shape', share: 0.95 })
    expect(cols['施行日'].roleBasis).toEqual({ rule: 'date-shape', share: 0.95 })
    // One dot is a number, however many digits come before it
    expect(cols['金額'].role).toBe('numeric-text')
  })

  it('takes digits that start with a zero for a code, not a number written as text', async () => {
    // The reader keeps `010006` as text for its zero, and the number shape
    // takes it too; repeated prefecture codes are a code all the same
    const cols = await columns(
      ['団体コード', '都道府県コード', '件数'],
      Array.from({ length: 47 }, (_, i) => [
        `${String(i + 1).padStart(2, '0')}0006`,
        String((i % 5) + 1).padStart(2, '0'),
        i === 0 ? '-' : `${i}`,
      ])
    )
    expect(cols['団体コード'].roleBasis).toMatchObject({ rule: 'leading-zero' })
    expect(cols['都道府県コード'].role).toBe('identifier')
    // A dash keeps a count as text; no zero makes it a code
    expect(cols['件数'].role).toBe('numeric-text')
  })

  it('finds the one code with a leading zero on a row the sample skips', async () => {
    // 60,000 rows sample every second; the zero that kept the column text sits
    // on a row it skips
    const rows = Array.from({ length: 60_000 }, (_, i) => [i === 1 ? '010006' : `${130001 + i}`])
    const cols = await columns(['団体コード'], rows)
    expect(cols['団体コード']).toMatchObject({
      role: 'identifier',
      roleBasis: { rule: 'leading-zero' },
    })
  })

  it('matches a sparse column over every row when the sample misses its values', async () => {
    // 120,000 rows sample every third; the remarks sit on the rows it skips
    const rows = Array.from({ length: 120_000 }, (_, i) => [
      `${i}`,
      i % 3 === 1 && i < 6000 ? '駐車場は、正面にあります。' : '',
    ])
    const cols = await columns(['id', 'その他'], rows)
    expect(cols['その他'].roleBasis).toEqual({ rule: 'punctuation', share: 1 })
  })

  it('names the values that keep a number as text from being one past the sample size', async () => {
    // More rows than the sample: the examples are read over the sampled rows
    const rows = Array.from({ length: 60_000 }, (_, i) => [
      i % 2 ? '公園' : '広場',
      i % 9 ? '100' : '-',
    ])
    const cols = await columns(['区分', '金額'], rows)
    expect(cols['金額']).toEqual({
      role: 'numeric-text',
      roleBasis: { rule: 'number-shape', share: 1, examples: ['-'] },
    })
    expect(cols['区分'].values).toEqual(['広場', '公園'])
  })

  it('takes names in any language for names, and codes by their digits', async () => {
    // The same facility is a name whether it is written 港区役所 or Minato City Office
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn'
    const cols = await columns(
      ['施設名', 'name', '施設コード'],
      Array.from({ length: 40 }, (_, i) => [`第${letters[i]}公園`, `Park${letters[i]}`, `P${i}`])
    )
    expect(cols['施設名'].roleBasis).toEqual({ rule: 'distinct-values', share: 1 })
    expect(cols['name'].roleBasis).toEqual({ rule: 'distinct-values', share: 1 })
    expect(cols['施設コード'].roleBasis).toEqual({ rule: 'distinct-code', share: 1 })
  })

  it('reads prose by its shape in English as in Japanese', async () => {
    const cols = await columns(
      ['Remarks', 'notice', 'station'],
      Array.from({ length: 40 }, (_, i) => [
        i % 2 ? 'Closed' : 'Open late',
        `The office is closed on public holidays and day ${i}`,
        // An abbreviation followed by a space is not the end of a sentence
        `Shin-Okubo Sta. North exit ${String.fromCharCode(65 + (i % 26))}${i}`,
      ])
    )
    expect(cols['Remarks'].roleBasis).toEqual({ rule: 'name-hint', hint: 'Remarks' })
    // Six words or more: the shape of a sentence, where Japanese has hiragana
    expect(cols['notice'].roleBasis).toEqual({ rule: 'long-prose' })
    expect(cols['station'].role).not.toBe('free-text')
  })

  it('takes what is mostly digits for an identifier, not a name', async () => {
    // Coordinates, house numbers and amounts with units: nothing to search a table by
    const cols = await columns(
      ['location', '番地', '金額'],
      Array.from({ length: 40 }, (_, i) => [
        `"POINT (-73.${1000 + i} 40.${2000 + i})"`,
        `${i + 1}番${(i % 9) + 1}号`,
        `${i + 1}兆${370 + i}億円`,
      ])
    )
    for (const name of ['location', '番地', '金額']) {
      expect(cols[name]).toMatchObject({ role: 'identifier', roleBasis: { rule: 'mostly-digits' } })
    }
  })

  it('takes an English heading as a hint only as the whole heading', async () => {
    // `cuisine_description` holds cuisines; `Description` holds prose
    const cols = await columns(
      ['cuisine_description', 'Description'],
      Array.from({ length: 10 }, (_, i) => [
        i % 2 ? 'American' : 'Chinese',
        i % 2 ? 'Open late' : 'Closed',
      ])
    )
    expect(cols['cuisine_description'].role).toBe('category')
    expect(cols['Description'].roleBasis).toEqual({ rule: 'name-hint', hint: 'Description' })
  })

  it('does not take every heading containing "id" for an identifier', async () => {
    const cols = await columns(
      ['Provider', 'user_id'],
      Array.from({ length: 10 }, (_, i) => [i % 2 ? 'NTT' : 'KDDI', i % 2 ? 'A' : 'B'])
    )
    expect(cols['Provider'].role).toBe('category')
    expect(cols['user_id'].roleBasis).toEqual({ rule: 'name-hint', hint: '_id' })
  })

  it('takes a heading as the evidence where the values leave it open', async () => {
    const cols = await columns(
      ['備考', '区分'],
      Array.from({ length: 10 }, (_, i) => [
        i % 2 ? '施設改修のため休館' : '臨時休業日あり',
        i % 2 ? 'A' : 'B',
      ])
    )
    expect(cols['備考']).toMatchObject({
      role: 'free-text',
      roleBasis: { rule: 'name-hint', hint: '備考' },
    })
    expect(cols['区分'].role).toBe('category')
  })
})

describe('interpretCsv — the profile artifact', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-profile-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function profile(lines: string[]) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, lines.join('\n') + '\n')
    const path = join(dir, 'profile.ndjson.zst')
    const result = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0, {
      path,
      vocabularyPacks: [],
    })
    const read = () =>
      zstdDecompressSync(readFileSync(path))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TableProfileLine)
    return { result, read }
  }

  it('holds every value of a listed column with its count and first row, then the sentences', async () => {
    const { result, read } = await profile([
      '区分,施設名,備考',
      '公園,東公園,駐車場は、正面にあります。',
      '公園,西公園,',
      '広場,中央広場,駐車場は、正面にあります。',
      '公園,北公園,雨天時は、閉鎖します。',
      '公園,東公園,駐車場は、正面にあります。',
    ])

    expect(result.profile).toMatchObject({ path: expect.any(String) })
    expect(result.profile?.sentencesOmitted).toBeUndefined()
    const lines = read()
    // 施設名 is a category here: too few values to be a name. Both are listed.
    expect(lines.filter((l) => l.column === '区分')).toEqual([
      { kind: 'value', column: '区分', text: '公園', count: 4, row: 1 },
      { kind: 'value', column: '区分', text: '広場', count: 1, row: 3 },
    ])
    // The least varied category column gives the context; the same sentence
    // once, at the first row that reads it
    expect(lines.filter((l) => l.kind === 'sentence')).toEqual([
      {
        kind: 'sentence',
        column: null,
        text: '区分: 公園 / 施設名: 東公園 / 備考: 駐車場は、正面にあります。',
        count: 2,
        row: 1,
      },
      {
        kind: 'sentence',
        column: null,
        text: '区分: 広場 / 施設名: 中央広場 / 備考: 駐車場は、正面にあります。',
        count: 1,
        row: 3,
      },
      {
        kind: 'sentence',
        column: null,
        text: '区分: 公園 / 施設名: 北公園 / 備考: 雨天時は、閉鎖します。',
        count: 1,
        row: 4,
      },
    ])
  })

  it('keeps every value, where the database keeps the most frequent', async () => {
    const kanji = '甲乙丙丁戊己庚辛壬癸'
    const many = Array.from(
      { length: 1000 },
      (_, i) => `${kanji[i % 10]}${kanji[Math.floor(i / 10) % 10]}${kanji[Math.floor(i / 100)]}事業`
    )
    const { result, read } = await profile(['事業名', ...many])
    expect(result.profile!.columns[0].values).toHaveLength(COLUMN_VALUES_KEPT)
    expect(read()).toHaveLength(1000)
  })

  it('numbers rows as the table does when the file has a column named rowid', async () => {
    // DuckDB's own row number goes by that name, and a heading must not hide it
    const { result, read } = await profile(['ROWID,区分', '甲,公園', '乙,広場', '甲,公園'])
    expect(result.profile!.columns.map((c) => c.role)).toEqual(['category', 'category'])
    expect(read().filter((l) => l.column === '区分')).toEqual([
      { kind: 'value', column: '区分', text: '公園', count: 2, row: 1 },
      { kind: 'value', column: '区分', text: '広場', count: 1, row: 2 },
    ])
    // Under its own heading, in the artifact and the schema alike
    expect(
      read()
        .filter((l) => l.column === 'ROWID')
        .map((l) => l.text)
    ).toEqual(['甲', '乙'])
    expect(result.schema.columns.map((c) => c.name)).toEqual(['ROWID', '区分'])
  })

  it('stops the sentences at the cap and counts what it left out', async () => {
    // 100 characters of 3 bytes plus the heading: about 300 bytes a sentence
    const rows = Array.from(
      { length: 2500 },
      (_, i) => `${String(i).padStart(5, '0')}、${'あ'.repeat(100)}`
    )
    const { result, read } = await profile(['備考', ...rows])
    const sentences = read().filter((l) => l.kind === 'sentence')
    expect(sentences.length + result.profile!.sentencesOmitted!).toBe(2500)
    expect(result.profile!.sentencesOmitted).toBeGreaterThan(0)
    const bytes = sentences.reduce((n, l) => n + Buffer.byteLength(l.text), 0)
    expect(bytes).toBeLessThanOrEqual(TABLE_SENTENCES_MAX_BYTES)
    // The first rows are the ones kept
    expect(sentences.at(-1)!.row).toBe(sentences.length)
  })

  it('works out no roles for a caller that wants the table alone', async () => {
    // The lake retry: a version keeps no profile, so working one out is waste
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, '区分\n公園\n')
    const { profile } = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0)
    expect(profile).toBeUndefined()
  })

  it('keeps the preview and says why when the profile cannot be made', async () => {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, '区分\n公園\n')
    const parquetPath = join(dir, 'out.parquet')
    const result = await interpretCsv(csvPath, parquetPath, 0, {
      path: join(dir, 'missing', 'p.gz'),
      vocabularyPacks: [],
    })
    expect(existsSync(parquetPath)).toBe(true)
    expect(result.schema.columns.map((c) => c.name)).toEqual(['区分'])
    expect(result.profile).toEqual({ columns: [], error: expect.any(String) })
  })

  it('writes nothing for a table of numbers and codes', async () => {
    const { result } = await profile(['id,金額', '1,100', '2,200'])
    expect(result.profile?.path).toBeUndefined()
    expect(existsSync(join(dir, 'profile.ndjson.zst'))).toBe(false)
  })
})

describe('interpretCsv — vocabulary', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-vocab-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function profile(rows: string[][], packs: string[]) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, rows.map((r) => r.join(',')).join('\n') + '\n')
    const { schema, profile } = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0, {
      path: join(dir, 'profile.ndjson.zst'),
      vocabularyPacks: packs,
    })
    const columns = Object.fromEntries(schema.columns.map((c, i) => [c.name, profile!.columns[i]]))
    return { columns, registry: profile!.registry }
  }

  const prefectures = [
    ['団体コード', '団体名', '区コード'],
    ['010006', '北海道', '131016'],
    ['020001', '青森県', '131024'],
    ['030007', '岩手県', '131032'],
    ['130001', '東京都', '131041'],
  ]

  it('reads codes as identifiers and names as names, under the registry it records', async () => {
    const { columns, registry } = await profile(prefectures, ['JP'])
    expect(columns['団体コード']).toMatchObject({
      role: 'identifier',
      roleBasis: { rule: 'vocabulary' },
      vocabulary: {
        concept: 'admin-area',
        pack: 'JP',
        scheme: 'jp-area-code',
        representation: 'code6',
        share: 1,
        levels: [{ level: 'ADM1', matched: 4, total: 47 }],
      },
    })
    // A name keeps the role it had — four names are a category — its values
    // being what a search looks for
    expect(columns['団体名']).toMatchObject({
      role: 'category',
      vocabulary: { representation: 'name' },
    })
    expect(registry).toMatch(/^rules@\d+;JP@/)
  })

  it('writes the search fields of the columns’ vocabulary onto the profile', async () => {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, prefectures.map((r) => r.join(',')).join('\n') + '\n')
    const { profile } = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0, {
      path: join(dir, 'profile.ndjson.zst'),
      vocabularyPacks: ['JP'],
    })
    expect(profile?.search).toEqual({
      vocab_meanings: ['admin-area:code', 'admin-area:name'],
      area_roots: ['010006', '020001', '030007', '130001'],
      area_places: ['131016', '131024', '131032', '131041'],
    })
  })

  it('reads an integer column as the codes it was written as', async () => {
    // Tokyo's wards: no leading zero, so DuckDB types the column an integer
    const { columns } = await profile(prefectures, ['JP'])
    expect(columns['区コード']).toMatchObject({
      role: 'identifier',
      vocabulary: { representation: 'code6', levels: [{ level: 'ADM2', matched: 4 }] },
    })
  })

  it('reads one integer down a column only under a heading that names a code', async () => {
    // A month checks out as a code as often as a code does
    const { columns } = await profile(
      [
        ['年月', '全国地方公共団体コード'],
        ['202011', '131032'],
        ['202011', '131032'],
      ],
      ['JP']
    )
    expect(columns['年月']).toMatchObject({ role: 'measure' })
    expect(columns['年月'].vocabulary).toBeUndefined()
    expect(columns['全国地方公共団体コード']).toMatchObject({
      role: 'identifier',
      vocabulary: { representation: 'code6' },
    })
  })

  it('takes two-digit codes the names beside them bear out, and no others', async () => {
    const { columns } = await profile(
      [
        ['産地', '産地名', '順位'],
        ['01', '北海道', '03'],
        ['13', '東京都', '01'],
        ['27', '大阪府', '02'],
        ['47', '沖縄県', '04'],
      ],
      ['JP']
    )
    expect(columns['産地']).toMatchObject({
      role: 'identifier',
      roleBasis: { rule: 'vocabulary' },
      vocabulary: { representation: 'pref2', levels: [{ level: 'ADM1', matched: 4 }] },
    })
    // Prefecture codes as far as their values go, but not the prefecture on their row
    expect(columns['順位'].vocabulary).toBeUndefined()
  })

  it('takes a statistics table’s codes, its groups said by the names beside them', async () => {
    // Tokyo's population table: wards and cities, with 市部 and 町村部 among them,
    // Tokyo's own codes and in no code table
    const { columns } = await profile(
      [
        ['地域コード', '地域', '人口'],
        ['13550', '町村部', '57000'],
        ['13101', '千代田区', '68000'],
        ['13104', '新宿区', '350000'],
        ['13105', '文京区', '240000'],
        ['13200', '市部', '4200000'],
        ['13201', '八王子市', '560000'],
        ['13202', '立川市', '180000'],
        ['13203', '武蔵野市', '150000'],
        ['13204', '三鷹市', '190000'],
        ['13205', '青梅市', '130000'],
      ],
      ['JP']
    )
    expect(columns['地域']).toMatchObject({ vocabulary: { representation: 'name', share: 1 } })
    expect(columns['地域コード']).toMatchObject({
      role: 'identifier',
      vocabulary: { representation: 'code5', share: 0.8 },
    })
  })

  it('reads names several places share by the codes beside them', async () => {
    // Each name alone could be in several prefectures; the codes say Tokyo
    const { columns } = await profile(
      [
        ['コード', '区市町村'],
        ['13102', '中央区'],
        ['13103', '港区'],
        ['13117', '北区'],
        ['13206', '府中市'],
        ['13303', '瑞穂町'],
        ['13361', '大島町'],
      ],
      ['JP']
    )
    expect(columns['区市町村']).toMatchObject({
      vocabulary: { representation: 'name', share: 1, ambiguous: 0 },
    })
    expect(columns['コード']).toMatchObject({
      role: 'identifier',
      vocabulary: { representation: 'code5' },
    })
  })

  it('prefers the reading the codes give over one with names left undecided', async () => {
    // 中央区 and 港区 are several places alone; the share is 1 either way
    const { columns } = await profile(
      [
        ['団体コード', '区名'],
        ['131016', '千代田区'],
        ['131024', '中央区'],
        ['131032', '港区'],
        ['131041', '新宿区'],
        ['131059', '文京区'],
      ],
      ['JP']
    )
    expect(columns['区名']).toMatchObject({ vocabulary: { share: 1, ambiguous: 0 } })
  })

  it('records the places a search finds the table by, from every row', async () => {
    // Osaka's 中央区 is one row of fifty thousand: the sample a reading by codes
    // is judged on may miss it, and the places must not
    const tokyo: [string, string][] = [
      ['13101', '千代田区'],
      ['13102', '中央区'],
      ['13103', '港区'],
      ['13104', '新宿区'],
      ['13105', '文京区'],
    ]
    const rows = [
      ['コード', '区'],
      ...Array.from({ length: 50_000 }, (_, k) => [...tokyo[k % tokyo.length]]),
      ['27128', '中央区'],
    ]
    const { columns } = await profile(rows, ['JP'])
    expect(columns['区']).toMatchObject({
      vocabulary: { kind: 'name', roots: ['130001', '270008'] },
    })
    expect(columns['区'].vocabulary?.places).toContain('271284')
    expect(columns['コード']).toMatchObject({
      vocabulary: { kind: 'code', roots: ['130001', '270008'] },
    })
  })

  it('reads names by the codes beside them from every row, shared or not', async () => {
    // No name here is shared, and the rows a sample may miss hold Osaka's ward
    // and a name of no place: the reading is judged and its places recorded
    // over the whole column, not over the sample's share
    const tokyo: [string, string][] = [
      ['13101', '千代田区'],
      ['13104', '新宿区'],
      ['13105', '文京区'],
      ['13106', '台東区'],
      ['13107', '墨田区'],
    ]
    const rows = [
      ['コード', '区'],
      ...Array.from({ length: 50_000 }, (_, k) => [...tokyo[k % tokyo.length]]),
      ['27119', '阿倍野区'],
      ['13108', 'ほげ'],
      // A row whose code is blank: only the names say where it is
      ['', '大阪府'],
    ]
    const { columns } = await profile(rows, ['JP'])
    expect(columns['区'].vocabulary?.places).toContain('271195')
    expect(columns['区'].vocabulary?.places).toContain('270008')
    expect(columns['区'].vocabulary?.share).toBeLessThan(1)
  })

  it('records no state where no enabled pack is one this release ships', async () => {
    // A setting a newer release wrote: the refresh takes it for no pack at all
    const { columns, registry } = await profile(prefectures, ['ZZ'])
    expect(columns['団体コード'].vocabulary).toBeUndefined()
    expect(registry).toBeUndefined()
  })

  it('reads nothing with no pack enabled', async () => {
    const { columns, registry } = await profile(prefectures, [])
    expect(columns['団体名'].vocabulary).toBeUndefined()
    expect(columns['団体コード'].vocabulary).toBeUndefined()
    expect(registry).toBeUndefined()
  })
})
