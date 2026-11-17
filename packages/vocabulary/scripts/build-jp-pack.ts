/**
 * Build the Japan pack's code table (ADR-073 §決定 9) from three lists:
 *
 * - the Digital Agency's City Master (市区町村マスター, Address Base Registry):
 *   each local government's code, name, kana and romanization, and the county
 *   each town is in;
 * - the Ministry of Internal Affairs and Communications' Standard Area Code for
 *   Statistics (統計に用いる標準地域コード): the groups of areas the City Master
 *   lacks (counties, branch offices, the ward area), and which areas each groups;
 * - the same Ministry's list of changes to the local government codes since
 *   2005 (https://www.soumu.go.jp/denshijiti/code.html), for the codes retired.
 *
 *   pnpm --filter @kukan/vocabulary build:jp-pack \
 *     --cities <URL> --areas <URL> --changes <URL>
 *
 * Run by hand when the lists change, and the result committed: a closed network
 * builds without reaching the publishers. The lists are taken by URL, which the
 * pack records as its sources — a local path would put a maintainer's disk in
 * it. The pack's version is the latest date the City Master's areas took
 * effect, and a hash of what was made of the lists: any change in the table
 * changes the version, which is what rebuilds the inferences made under the old
 * one (ADR-073 §決定 4).
 *
 * The two current lists are held to each other: the run stops when their local
 * government codes differ, or a county of the standard area code is not one the
 * City Master names. Names and kana that differ are listed, and the City
 * Master's are kept.
 *
 * Needs DuckDB's `excel` extension, which it installs on first run, and `unzip`.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { checkDigit, hasValidCheckDigit } from '../src/fold'
import type { CheckDigitRule, CodeEntry, Name, Source } from '../src/types'

/** The rule the codes are built on, which the pack names as its own. */
const RULE: CheckDigitRule = 'mod11-weights-6-2'

/**
 * Rows read off the change list: far past its length today, and a list that
 * reaches the end stops the run rather than losing its oldest changes.
 */
const CHANGE_ROWS = 20_000

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/packs/jp/codes.json')

// Strict, so a misspelt flag stops the run instead of being guessed around. The
// command takes no bare `--`: pnpm passes it on, and parseArgs refuses it
const { values: args } = parseArgs({
  options: {
    cities: { type: 'string' },
    areas: { type: 'string' },
    changes: { type: 'string' },
  },
  strict: true,
})

/** The terms each list falls under: the Public Data License, by the publisher's own page. */
const publicDataLicense = (url: string) => ({
  name: '公共データ利用規約（第1.0版）',
  url,
  derivatives: true,
})

/**
 * Readings the City Master gets wrong, checked against the place's own: a
 * correction is made only once the place's reading is confirmed.
 */
const KANA_CORRECTIONS: Record<string, string> = {
  // 真鶴町 calls itself まなづる
  '143839': 'マナヅルマチ',
}

/** Romanized names the City Master writes cut short, as the rest of its rows write them. */
const ROMANIZED_CORRECTIONS: Record<string, string> = {
  // The suffix is missing: `Ichikawamisato-`
  '193461': 'Ichikawamisato-cho',
}

/**
 * The romanized names where an n ends a syllable before a vowel or y, which the
 * GSI's rules part with a hyphen and the City Master does not (`Kanonji`).
 * Listed by hand: kana and romanization do not line up letter by letter, and
 * the run stops on any such name missing here.
 */
const N_HYPHENS: Record<string, string> = {
  '062138': 'Nan-yo',
  '073440': 'Ten-ei',
  '285862': 'Shin-onsen',
  '352161': 'San-yoonoda',
  '372056': 'Kan-onji',
}

/** Tokyo's ward area (特別区部), a group of the standard area code's. */
const WARD_AREA = '131008'

/** Whether a code is one of Tokyo's special wards, whose codes run from 131. */
const isSpecialWard = (code: string) => code.startsWith('131') && code !== WARD_AREA

/**
 * The groups the GSI's rules do not cover — a prefecture's branch offices and
 * Tokyo's ward area — named in English by the pack.
 */
const GROUP_ENGLISH: Record<string, string> = {
  '013005': 'Ishikari Subprefecture',
  '013307': 'Oshima General Subprefecture',
  '013609': 'Hiyama Subprefecture',
  '013901': 'Shiribeshi General Subprefecture',
  '014206': 'Sorachi General Subprefecture',
  '014508': 'Kamikawa General Subprefecture',
  '014800': 'Rumoi Subprefecture',
  '015105': 'Soya General Subprefecture',
  '015407': 'Okhotsk General Subprefecture',
  '015709': 'Iburi General Subprefecture',
  '016004': 'Hidaka Subprefecture',
  '016306': 'Tokachi General Subprefecture',
  '016608': 'Kushiro General Subprefecture',
  '016900': 'Nemuro Subprefecture',
  [WARD_AREA]: 'Tokyo Special Wards',
  '133604': 'Oshima Subprefecture',
  '133809': 'Miyake Subprefecture',
  '134007': 'Hachijo Subprefecture',
  '134201': 'Ogasawara Subprefecture',
}

/** The standard area code's ward area has no reading of its own. */
const GROUP_KANA: Record<string, string> = { [WARD_AREA]: 'トクベツクブ' }

/** The kinds of group the standard area code holds, by how their names end (総合振興局 too). */
const GROUP_KINDS = ['振興局', '支庁', '特別区部', '郡'] as const

/** A new file of the run's own, for a list as fetched or as converted. */
function tempFile(name: string, data: Buffer | string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'jp-pack-')), name)
  writeFileSync(path, data)
  return path
}

async function download(url: string): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new Error(`Give the list's URL, not a path: ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return tempFile(basename(new URL(url).pathname), Buffer.from(await res.arrayBuffer()))
}

const ERAS: Record<string, number> = { R: 2018, H: 1988, S: 1925 }

/**
 * `R6.1.1` → `2024-01-01`. Some cells hold a date Excel stored as its serial
 * number of days from 1899-12-30, which reads back as `41734`.
 */
function eraDate(text: string): string {
  if (/^\d{5}$/.test(text.trim())) {
    return new Date(Date.UTC(1899, 11, 30) + Number(text) * 86_400_000).toISOString().slice(0, 10)
  }
  const m = /^([RHS])(\d+|元)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (!m) throw new Error(`Not an era date: ${text}`)
  const year = ERAS[m[1]] + (m[2] === '元' ? 1 : Number(m[2]))
  return `${year}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`
}

const code6 = (code5: string) => `${code5}${checkDigit(RULE, code5)}`

/** The code of the prefecture a code is in. */
const prefCode = (code: string) => code6(`${code.slice(0, 2)}000`)

const official = (text: string, lang = 'ja'): Name => ({ text, lang, kind: 'official' })

/** Hiragana as katakana, the City Master's way of writing a reading. */
const katakana = (s: string) =>
  s.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))

/**
 * An area's English name by the GSI's rules for English place names (地名等の
 * 英語表記規程, articles 13–15): the romanized name with its Japanese suffix
 * replaced by the English word, and 「ん」 always n.
 *
 * @param romanized - as the City Master writes it: `Sapporo-shi`, `Gumma`.
 * @param name - the Japanese name, which says what a prefecture is.
 */
function englishName(code: string, romanized: string, name: string, kana: string): string {
  const prefecture = /[都道府県]$/.exec(name)?.[0]
  const [base, suffix] = prefecture ? [romanized, ''] : splitSuffix(romanized)
  // The City Master writes Hepburn's m before b, m and p (Gumma); the rules write n
  let part = base.replace(/m(?=[bmp])/g, 'n')
  if (/ン[アイウエオヤユヨ]/.test(kana)) {
    const hyphened = N_HYPHENS[code]
    if (!hyphened || hyphened.replace('-', '').toLowerCase() !== part.toLowerCase()) {
      throw new Error(`${code} ${name} (${kana}): add its hyphened name to N_HYPHENS`)
    }
    part = hyphened
  }
  if (prefecture === '都') return `${part} Metropolis`
  if (prefecture) return `${part} Prefecture`
  return `${part} ${englishWord(code, suffix)}`
}

function splitSuffix(romanized: string): [string, string] {
  const at = romanized.lastIndexOf('-')
  if (at < 0) throw new Error(`No suffix to replace: ${romanized}`)
  return [romanized.slice(0, at), romanized.slice(at + 1)]
}

function englishWord(code: string, suffix: string): string {
  switch (suffix) {
    case 'shi':
      return 'City'
    // Tokyo's 23 wards are cities in the rules; a designated city's are wards
    case 'ku':
      return isSpecialWard(code) ? 'City' : 'Ward'
    case 'cho':
    case 'machi':
      return 'Town'
    case 'mura':
    case 'son':
      return 'Village'
    case 'gun':
      return 'County'
    default:
      throw new Error(`Unknown suffix -${suffix} on ${code}`)
  }
}

type Row = Record<string, string | null>

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`

/** The rows a DuckDB reader gives, every cell as text. */
async function rows(conn: DuckDBConnection, reader: string, path: string, opts: string) {
  const result = await conn.runAndReadAll(
    `SELECT * FROM ${reader}(${sqlString(path)}, all_varchar = true, ${opts})`
  )
  return result.getRowObjectsJson() as Row[]
}

/**
 * A CSV's rows, with each cell trimmed and an empty one null: the two CSVs
 * leave a column blank where it has nothing to say, which the change list's
 * reading handles cell by cell instead.
 */
async function csvRows(conn: DuckDBConnection, path: string): Promise<Row[]> {
  return (await rows(conn, 'read_csv', path, 'header = true')).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v?.trim() || null]))
  )
}

async function main() {
  const { cities: citiesArg, areas: areasArg, changes: changesArg } = args
  if (!citiesArg || !areasArg || !changesArg) {
    throw new Error('Give --cities, --areas and --changes: the URLs of the three lists')
  }
  const conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run('INSTALL excel; LOAD excel;')
  // The City Master is one CSV in a zip; the standard area code's is Shift_JIS
  const citiesZip = await download(citiesArg)
  const cities = await csvRows(
    conn,
    tempFile('cities.csv', execFileSync('unzip', ['-p', citiesZip], { maxBuffer: 64 << 20 }))
  )
  const areasSjis = await download(areasArg)
  const areas = await csvRows(
    conn,
    tempFile('areas.csv', new TextDecoder('shift_jis').decode(readFileSync(areasSjis)))
  )
  const changesPath = await download(changesArg)
  if (!cities[0] || !('lg_code' in cities[0]))
    throw new Error('No lg_code column in the City Master')
  if (!areas[0] || !('tiiki-code' in areas[0])) throw new Error('No tiiki-code column in the areas')

  const entries = new Map<string, CodeEntry>()
  const differences: string[] = []
  const names = (code: string, ja: string, kana: string, romanized: string): Name[] => {
    const reading = KANA_CORRECTIONS[code] ?? kana
    return [
      official(ja),
      official(reading, 'ja-Hrkt'),
      official(englishName(code, ROMANIZED_CORRECTIONS[code] ?? romanized, ja, reading), 'en'),
    ]
  }

  // Each row is a municipality or a designated city's ward; the prefecture is in its columns
  const cityOf = new Map<string, string>()
  for (const r of cities) {
    const code = r.lg_code!
    const pref = prefCode(code)
    if (!entries.has(pref)) {
      entries.set(pref, {
        code: pref,
        level: 'ADM1',
        names: names(pref, r.pref!, r.pref_kana!, r.pref_roma!),
      })
    }
    if (!r.ward) {
      entries.set(code, {
        code,
        level: 'ADM2',
        parent: pref,
        names: names(code, r.city!, r.city_kana!, r.city_roma!),
      })
      cityOf.set(`${r.pref}${r.city}`, code)
    }
  }
  // A ward's city is the row naming the city alone, not its code's first
  // digits, which Osaka's 24 wards run past
  const designated = new Set<string>()
  for (const r of cities) {
    if (!r.ward) continue
    const city = cityOf.get(`${r.pref}${r.city}`)
    if (!city) throw new Error(`No row for the city of ward ${r.lg_code}`)
    designated.add(city)
    entries.set(r.lg_code!, {
      code: r.lg_code!,
      level: 'ADM3',
      parent: city,
      names: names(r.lg_code!, r.ward, r.ward_kana!, r.ward_roma!),
    })
  }

  // The standard area code: the same local governments, and the groups among them
  const groupByName = new Map<string, string>()
  const listed = new Set<string>()
  for (const r of areas) {
    const code = code6(r['tiiki-code']!)
    const name =
      r['sityouson-name3'] ?? r['sityouson-name2'] ?? r['sityouson-name1'] ?? r['ken-name']!
    const kana = katakana(r.yomigana ?? '')
    const known = entries.get(code)
    if (known) {
      listed.add(code)
      const [ja, reading] = known.names
      if (ja.text !== name) differences.push(`${code} name: ${ja.text} / ${name}`)
      if (reading.text !== kana) differences.push(`${code} kana: ${reading.text} / ${kana}`)
      continue
    }
    const kind = GROUP_KINDS.find((k) => name.endsWith(k))
    if (!kind) throw new Error(`${code} ${name}: a local government the City Master lacks`)
    groupByName.set(`${r['ken-name']}${name}`, code)
    entries.set(code, {
      code,
      group: kind,
      parent: prefCode(code),
      names: [official(name), official(GROUP_KANA[code] ?? kana, 'ja-Hrkt')],
    })
  }
  const unlisted = [...entries.keys()].filter((c) => !listed.has(c) && !entries.get(c)!.group)
  if (unlisted.length > 0) {
    throw new Error(`Local governments the standard area code lacks: ${unlisted.join(', ')}`)
  }

  // Which groups each area is in: the group a row of the standard area code
  // names before it, and the county the City Master gives
  for (const r of areas) {
    const code = code6(r['tiiki-code']!)
    const group = groupByName.get(`${r['ken-name']}${r['sityouson-name1'] ?? ''}`)
    if (group && group !== code) joinGroup(entries.get(code)!, group)
    // Tokyo's special wards are the ward area's, which their rows do not name
    if (isSpecialWard(code)) joinGroup(entries.get(code)!, WARD_AREA)
  }
  const counties = new Map<string, { kana: string; romanized: string }>()
  for (const r of cities) {
    if (!r.county) continue
    const key = `${r.pref}${r.county}`
    counties.set(key, { kana: r.county_kana!, romanized: r.county_roma! })
    const group = groupByName.get(key)
    if (group) joinGroup(entries.get(r.lg_code!)!, group)
  }
  for (const [key, code] of groupByName) {
    const entry = entries.get(code)!
    const english = GROUP_ENGLISH[code]
    if (english) {
      entry.names.push(official(english, 'en'))
      continue
    }
    const county = counties.get(key)
    if (entry.group !== '郡' || !county) {
      throw new Error(`${code} ${key}: no English name, and not a county the City Master names`)
    }
    const [ja, reading] = entry.names
    if (county.kana !== reading.text) {
      differences.push(`${code} kana: ${county.kana} / ${reading.text}`)
    }
    entry.names = names(code, ja.text, county.kana, county.romanized)
  }

  const changeRows = await rows(
    conn,
    'read_xlsx',
    changesPath,
    `header = false, range = 'A1:N${CHANGE_ROWS}', stop_at_empty = false`
  )
  if (Object.values(changeRows.at(-1) ?? {}).some((v) => v !== null)) {
    throw new Error(`The change list reaches row ${CHANGE_ROWS}: raise CHANGE_ROWS`)
  }
  applyChanges(changeRows, entries, designated)

  for (const entry of entries.values()) addAliases(entry)
  const sorted = [...entries.values()].sort(
    (a, b) => a.code.localeCompare(b.code) || (a.validFrom ?? '').localeCompare(b.validFrom ?? '')
  )
  for (const e of sorted) {
    if (!hasValidCheckDigit(RULE, e.code)) {
      throw new Error(`Check digit does not hold: ${e.code}`)
    }
  }

  const retrieved = new Date().toISOString().slice(0, 10)
  const dataDate = cities.map((r) => r.efct_date!).reduce((a, b) => (a > b ? a : b))
  const sources: Source[] = [
    {
      publisher: 'デジタル庁',
      title: 'アドレス・ベース・レジストリ 市区町村マスター',
      url: citiesArg,
      retrieved,
      license: publicDataLicense('https://www.digital.go.jp/policies/base_registry_address_tos'),
      processed:
        '都道府県のコードを検査数字の式で6桁にし、英語名を国土地理院「地名等の英語表記規程」の形に置き換え、読みとローマ字の誤りを補正した',
    },
    {
      publisher: '総務省',
      title: '統計に用いる標準地域コード',
      url: areasArg,
      retrieved,
      license: publicDataLicense('https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html'),
      processed: '区域のまとまりを取り出し、検査数字を足して6桁のコードにした',
    },
    {
      publisher: '総務省',
      title: '全国地方公共団体コード 改正一覧',
      url: changesArg,
      retrieved,
      license: publicDataLicense('https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html'),
      processed: '廃止・名称変更を、コードと名称の有効期間として読んだ',
    },
  ]
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        version: `${dataDate}+${createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12)}`,
        sources,
        codes: sorted,
      },
      null,
      1
    ) + '\n'
  )
  for (const d of differences) console.log(`differs (City Master / standard area code): ${d}`)
  console.log(`${sorted.length} entries, areas in effect by ${dataDate}, written to ${OUT}`)
}

/** An area joining a group, once. */
function joinGroup(entry: CodeEntry, group: string) {
  if (!entry.groups?.includes(group)) entry.groups = [...(entry.groups ?? []), group]
}

/**
 * The change list in its own layout: columns E–N are the prefecture, the old
 * code and name, the kind of change, the new code and name, the reason and the
 * date. `〃` repeats the row above; a date is written once per change, usually on
 * its last row, so the rows before it take it from below — and a last row left
 * undated takes it from above.
 * A change starts at a row naming its prefecture; the order column is no guide,
 * since a change's new code can carry an order of its own.
 */
function applyChanges(raw: Row[], entries: Map<string, CodeEntry>, designated: Set<string>) {
  const data = raw.filter(
    (r) => /^\d{6}$/.test(r.F?.trim() ?? '') || /^\d{6}$/.test(r.J?.trim() ?? '')
  )
  const ditto = (v: string | null | undefined, prev: string | undefined) =>
    v?.trim() === '〃' ? prev : v?.trim() || undefined

  const dates: (string | undefined)[] = []
  let prev: string | undefined
  for (const r of data) {
    const d = ditto(r.N, prev)
    dates.push(d)
    if (d) prev = d
  }
  for (let i = data.length - 2; i >= 0; i--) {
    const next = data[i + 1]
    const startsChange = !!next.E?.trim()
    if (!dates[i] && !startsChange) dates[i] = dates[i + 1]
  }
  // A change whose new code closes it undated takes the date written above it
  for (let i = 1; i < data.length; i++) {
    if (!dates[i] && !data[i].E?.trim()) dates[i] = dates[i - 1]
  }

  const retired: CodeEntry[] = []
  let kind: string | undefined
  let lastNew: string | undefined
  let lastName: string | undefined
  data.forEach((r, i) => {
    kind = ditto(r.I, kind)
    // `〃` stands for the row above in the new code and name too: 同左 repeated
    const newCode = ditto(r.J, lastNew)
    const newName = ditto(r.K, lastName)
    lastNew = newCode
    lastName = newName
    // The code and the name both 同左: the city that took a merger in, which
    // keeps both, and whose row often carries no date of its own
    if (newCode === '同左' && (newName === '同左' || !newName)) return
    const written = dates[i]
    if (!written) throw new Error(`No date for the change at ${r.F ?? r.J}`)
    const date = eraDate(written)
    const oldCode = r.F?.trim()

    if (oldCode && /^\d{6}$/.test(oldCode)) {
      const oldName = r.G!.trim()
      if (newCode === '同左' && newName) {
        // Renamed: the code stays, the name it had ends here
        // A code renamed and retired the same day (三好町 → みよし町 → みよし市) is
        // renamed first here, the list running newest first, before its retirement
        let entry = entries.get(oldCode)
        if (!entry) {
          entry = formerEntry(oldCode, newName, designated)
          entries.set(oldCode, entry)
        }
        // The name it took starts here. A name it took later ended it already,
        // the list running newest first; only the current one carries its
        // reading and English name along
        const took = entry.names.find(
          (n) => n.kind === 'official' && n.lang === 'ja' && n.text === newName && !n.validFrom
        )
        if (!took) {
          throw new Error(`${oldCode} renamed to ${newName}, which the City Master names otherwise`)
        }
        const current = !took.validTo
        entry.names = entry.names.map((n) =>
          n === took || (current && n.kind === 'official' && !n.validFrom && !n.validTo)
            ? { ...n, validFrom: date }
            : n
        )
        entry.names.push({ ...official(oldName), validTo: date })
        return
      }
      const current = entries.get(oldCode)
      if (current?.validFrom !== undefined && current.validFrom >= date) {
        // Retired, then given out again: the earlier use is an entry of its own
        retired.push({ ...formerEntry(oldCode, oldName, designated), validTo: date })
      } else if (current) {
        current.validTo = date
      } else {
        entries.set(oldCode, { ...formerEntry(oldCode, oldName, designated), validTo: date })
      }
    }
    // A new code on a row of its own is a new code, whether or not its kind says so
    if (newCode && /^\d{6}$/.test(newCode) && (kind === '新設' || !oldCode)) {
      const entry = entries.get(newCode)
      if (entry && entry.validFrom === undefined) entry.validFrom = date
    }
  })
  for (const e of retired) entries.set(`${e.code}@${e.validTo}`, e)
}

/** A code the current list no longer has; the change list names a ward by its own name already (`中区`). */
function formerEntry(code: string, name: string, designated: Set<string>): CodeEntry {
  const city = wardCity(code, designated)
  return city
    ? { code, level: 'ADM3', parent: city, names: [official(name)] }
    : { code, level: 'ADM2', parent: prefCode(code), names: [official(name)] }
}

/**
 * The designated city a retired code was a ward of, or undefined when it was not
 * a ward. Wards and designated cities share a range, the third digit 1, which
 * Tokyo's special wards also use but are municipalities; a ward belongs to the
 * nearest designated city at or below it in its prefecture.
 */
function wardCity(code: string, designated: Set<string>): string | undefined {
  if (code.startsWith('13') || code[2] !== '1' || designated.has(code)) return undefined
  return [...designated]
    .filter((c) => c.slice(0, 2) === code.slice(0, 2) && c <= code)
    .sort()
    .at(-1)
}

/** A prefecture written without its 都・府・県 (`東京`, `大阪`), as data often does. */
function addAliases(entry: CodeEntry) {
  if (entry.level !== 'ADM1') return
  const aliases = entry.names
    .filter((n) => n.kind === 'official' && n.lang === 'ja' && /[都府県]$/.test(n.text))
    .map((n): Name => ({ ...n, text: n.text.slice(0, -1), kind: 'alias' }))
  entry.names.push(...aliases)
}

await main()
