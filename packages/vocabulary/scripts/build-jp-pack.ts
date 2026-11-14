/**
 * Build the Japan pack's code table from the lists the Ministry of Internal
 * Affairs and Communications publishes (https://www.soumu.go.jp/denshijiti/code.html):
 * the current codes, with the designated cities' wards on a second sheet, and
 * the list of changes since 2005.
 *
 *   pnpm --filter @kukan/vocabulary build:jp-pack \
 *     --current <URL> --changes <URL> \
 *     [--sheet-current <name>] [--sheet-designated <name>]
 *
 * Run by hand when the lists change, and the result committed: a closed network
 * builds without reaching the ministry. The lists are taken by URL, which the
 * pack records as its source — a local path would put a maintainer's disk in
 * it. The sheet names carry the list's date (`R6.1.1現在の団体`), so they are
 * found from it unless given. The pack's version is the list's date and a hash
 * of what was made of it: any change in the table changes the version, which
 * is what rebuilds the inferences made under the old one (ADR-073 §決定 4).
 *
 * Needs DuckDB's `excel` extension, which it installs on first run.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { checkDigit, hasValidCheckDigit } from '../src/fold'
import type { CheckDigitRule, CodeEntry, Name } from '../src/types'

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
    current: { type: 'string' },
    changes: { type: 'string' },
    'sheet-current': { type: 'string' },
    'sheet-designated': { type: 'string' },
  },
  strict: true,
})

async function download(url: string): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new Error(`Give the list's URL, not a path: ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const path = join(mkdtempSync(join(tmpdir(), 'jp-pack-')), 'list.xlsx')
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  return path
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

const official = (text: string): Name => ({ text, lang: 'ja', kind: 'official' })

type Row = Record<string, string | null>

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`

async function rows(conn: DuckDBConnection, path: string, opts: string): Promise<Row[]> {
  const reader = await conn.runAndReadAll(
    `SELECT * FROM read_xlsx(${sqlString(path)}, all_varchar = true, ${opts})`
  )
  return reader.getRowObjectsJson() as Row[]
}

async function main() {
  const currentArg = args.current
  const changesArg = args.changes
  if (!currentArg || !changesArg) {
    throw new Error('Give --current and --changes: the URLs of the two lists')
  }
  const conn = await (await DuckDBInstance.create(':memory:')).connect()
  await conn.run('INSTALL excel; LOAD excel;')
  const currentPath = await download(currentArg)
  const changesPath = await download(changesArg)

  // The first sheet's name carries the list's date
  const firstSheet = args['sheet-current']
  const firstRows = await rows(
    conn,
    currentPath,
    firstSheet ? `sheet = ${sqlString(firstSheet)}` : 'header = true'
  )
  const header = Object.keys(firstRows[0] ?? {})
  if (!header.includes('団体コード'))
    throw new Error(`No 団体コード column in the current list: ${header.join(', ')}`)
  const sheetCurrent = firstSheet ?? sheetNames(currentPath)[0]
  const dated = /^([RHS](?:\d+|元)\.\d+\.\d+)/.exec(sheetCurrent)
  if (!dated) throw new Error(`Cannot read the list's date from the sheet name: ${sheetCurrent}`)
  const dataDate = eraDate(dated[1])
  const sheetDesignated = args['sheet-designated'] ?? `${dated[1]}政令指定都市`

  const entries = new Map<string, CodeEntry>()

  for (const r of firstRows) {
    const code = r['団体コード']?.trim()
    if (!code) continue
    const pref = r[header[1]]?.trim() ?? ''
    const muni = r[header[2]]?.trim()
    entries.set(
      code,
      muni
        ? { code, level: 'ADM2', parent: prefCode(code), names: [official(muni)] }
        : { code, level: 'ADM1', names: [official(pref)] }
    )
  }

  const designated = new Set<string>()
  const designatedRows = await rows(conn, currentPath, `sheet = ${sqlString(sheetDesignated)}`)
  const dHeader = Object.keys(designatedRows[0] ?? {})
  // Each city is followed by its wards: a ward's city is the row above them, not
  // its code's first digits, which Osaka's 24 wards run past. The list writes a
  // ward with its city (`札幌市中央区`); the table holds the ward's own name, and
  // the registry writes it behind its city as the scheme says
  let city: string | undefined
  for (const r of designatedRows) {
    const code = r['団体コード']?.trim()
    const name = r[dHeader[2]]?.trim()
    if (!code || !name) continue
    if (entries.get(code)?.level === 'ADM2') {
      designated.add(code)
      city = code
      continue
    }
    if (!city) throw new Error(`A ward before any city: ${code}`)
    const cityName = entries.get(city)!.names[0].text
    const own = name.startsWith(cityName) ? name.slice(cityName.length) : name
    entries.set(code, { code, level: 'ADM3', parent: city, names: [official(own)] })
  }

  const changeRows = await rows(
    conn,
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

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        version: `${dataDate}+${createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12)}`,
        retrieved: new Date().toISOString().slice(0, 10),
        sources: { current: currentArg, changes: changesArg },
        codes: sorted,
      },
      null,
      1
    ) + '\n'
  )
  console.log(`${sorted.length} entries, list of ${dataDate}, written to ${OUT}`)
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
        entry.names = entry.names.map((n) =>
          n.kind === 'official' && n.text === newName && !n.validFrom
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
    .filter((n) => n.kind === 'official' && /[都府県]$/.test(n.text))
    .map((n): Name => ({ ...n, text: n.text.slice(0, -1), kind: 'alias' }))
  entry.names.push(...aliases)
}

/** The sheets of a workbook, in order, read off its manifest. */
function sheetNames(path: string): string[] {
  const xml = execFileSync('unzip', ['-p', path, 'xl/workbook.xml']).toString('utf8')
  return [...xml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1])
}

await main()
