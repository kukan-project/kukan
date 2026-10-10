import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COLUMN_VALUES_KEPT,
  TABLE_SENTENCES_MAX_BYTES,
  type ColumnProfile,
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
    rows: string[][]
  ): Promise<Record<string, ColumnProfile>> {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, [header, ...rows].map((r) => r.join(',')).join('\n') + '\n')
    const { schema, profile } = await interpretCsv(
      csvPath,
      join(dir, 'out.parquet'),
      0,
      join(dir, 'profile.ndjson.zst')
    )
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
    const result = await interpretCsv(csvPath, join(dir, 'out.parquet'), 0, path)
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
    const result = await interpretCsv(csvPath, parquetPath, 0, join(dir, 'missing', 'p.gz'))
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
