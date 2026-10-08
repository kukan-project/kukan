/**
 * KUKAN Pipeline — the table profile (ADR-063 §決定 3・4)
 *
 * Counts, over the interpreted table, what the role rules read; keeps the most
 * frequent values of the columns a search finds a table by; and writes the
 * profile artifact the index is built from. Done where the table already is —
 * the interpretation's DuckDB — so nothing reads the CSV again.
 */

import type { DuckDBConnection } from '@duckdb/node-api'
import { sqlIdentifier, sqlLiteral } from '@kukan/lake'
import { COLUMN_VALUES_KEPT, TABLE_SENTENCES_MAX_BYTES } from '@kukan/shared'
import type { ColumnProfile, ResourceColumn, TableProfile } from '@kukan/shared'
import { aggregateByColumn } from './column-batches'
import { listsValues, textColumnRole, type TextColumnClues } from './column-role'

/** Values shown for why a `numeric-text` column is not a number. */
const NUMBER_EXAMPLES = 3

/** Category columns put in front of a sentence, the least varied first. */
const SENTENCE_CONTEXT_COLUMNS = 3

/**
 * One regex per clue, matched against the trimmed value. RE2 syntax; `full`
 * means the whole value has to match. Written from the spike's misses: dates
 * in eras or ending at the month, phone numbers in brackets, numbers with
 * full-width digits.
 *
 * A date separated by dots needs all three parts: `1234.56` is a number.
 */
const CLUES: Record<string, { full: boolean; re: string }> = {
  ascii: { full: true, re: '[0-9A-Za-z._/:\\-]+' },
  digits: { full: true, re: '[0-9０-９]+' },
  digit: { full: false, re: '[0-9０-９]' },
  // Japanese marks only: a Western `.` or `,` is as often an abbreviation
  // (`Sta. North exit`) or an inverted name (`Crane, wattled`) as a sentence
  punctuation: { full: false, re: '[。、．，]' },
  prose: { full: false, re: '[ぁ-ん]{2,}|\\S+(\\s+\\S+){5,}' },
  url: { full: true, re: 'https?://\\S+' },
  phone: { full: true, re: '0[0-9]{1,4}[-−‐－(（][0-9]{1,4}[-−‐－)）][0-9]{3,4}.*' },
  date: {
    full: true,
    re:
      '([0-9]{4}|[RHSrhs][0-9０-９元]{1,2}|(令和|平成|昭和)[0-9０-９元]{1,2})' +
      '([/／年-][0-9０-９]{1,2}月?([/／-]?[0-9０-９]{1,2}日?)?|[.．][0-9０-９]{1,2}[.．][0-9０-９]{1,2})',
  },
  number: {
    full: true,
    re: '[-−‐－▲△+＋]?\\s*[(（]?[0-9０-９][0-9０-９,，.．]*[)）]?\\s*[%％]?|[-−‐－…・*＊xX×]+',
  },
}

/**
 * Rows the shapes and lengths are measured over. The regexes are what a pass
 * costs — on 400,000 rows of ten text columns, matched over every row, they
 * took the interpretation from 1.9s to 2.9s, and 2.4s over this many — and a
 * share is as good from an even spread of rows as from all of them. Counts and
 * distinct counts are the schema's, over every row: the rules divide one by
 * the other, and a sample would make every column look more distinct than it is.
 */
const SHAPE_SAMPLE_ROWS = 50_000

/**
 * Values a column needs in the sample for its shares to stand. A column whose
 * values sit mostly in the rows the sample skips is measured over every row.
 */
const SHAPE_SAMPLE_MIN_VALUES = 1_000

/** A value DuckDB would read as a number as it stands. */
const PLAIN_NUMBER = '-?[0-9]+(\\.[0-9]+)?'

/** The trimmed value of a column, with blank as missing. */
const value = (name: string) => `nullif(trim(${sqlIdentifier(name)}), '')`

/** The profile as the interpretation hands it on: the artifact still on local disk. */
export type InterpretedProfile = Omit<TableProfile, 'key'> & {
  /** The artifact, where the table had anything to put in one. */
  path?: string
}

/**
 * The table's profile, with its artifact written to `path`.
 *
 * @param columns - as the table holds them, by DuckDB type, aligned with
 *   `described`.
 */
export async function profileTable(
  conn: DuckDBConnection,
  columns: { name: string; duckType: string }[],
  described: ResourceColumn[],
  rowCount: number,
  path: string
): Promise<InterpretedProfile> {
  // Every row number below is DuckDB's own rowid, and a heading must not hide it.
  const names = await freeRowid(
    conn,
    columns.map((c) => c.name)
  )
  // Every nth row rather than DuckDB's sampling, which is repeatable only on
  // one thread — and a role has to come out the same on every run. A filter on
  // `t` itself rather than a subquery, which would not carry rowid out.
  const stride = Math.max(1, Math.ceil(rowCount / SHAPE_SAMPLE_ROWS))
  const sample = stride === 1 ? 't' : `t WHERE rowid % ${stride} = 0`

  // Only text has a role to work out. Anything DuckDB typed — numbers, dates,
  // booleans, times — is a measure by its type.
  const text = columns.flatMap((c, i) => (c.duckType === 'VARCHAR' ? [i] : []))
  const clues = await countClues(conn, names, described, rowCount, text, sample)

  const profiled: ColumnProfile[] = []
  for (const [i, column] of described.entries()) {
    const counted = clues.get(i)
    if (!counted) {
      profiled.push({ role: 'measure', roleBasis: { rule: 'typed' } })
      continue
    }
    const decision = textColumnRole(column.name, counted)
    if (decision.role === 'numeric-text') {
      decision.roleBasis.examples = await notPlainNumbers(conn, names[i], stride)
    }
    profiled.push(decision)
  }

  const listed = profiled.flatMap((c, i) => (listsValues(c.role) ? [i] : []))
  const free = described.flatMap((_, i) => (profiled[i].role === 'free-text' ? [i] : []))
  if (listed.length === 0 && free.length === 0) return { columns: profiled }

  await countValues(conn, names, listed)
  for (const [i, values] of await mostFrequentValues(conn)) {
    profiled[i] = { ...profiled[i], values }
  }
  const context = described
    .flatMap((_, i) => (profiled[i].role === 'category' ? [i] : []))
    .sort((a, b) => (described[a].distinctCount ?? 0) - (described[b].distinctCount ?? 0))
    .slice(0, SENTENCE_CONTEXT_COLUMNS)
  const sentencesOmitted = await writeProfile(
    conn,
    described,
    names,
    [...context, ...free],
    free,
    path
  )
  return { columns: profiled, path, ...(sentencesOmitted > 0 && { sentencesOmitted }) }
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/**
 * The names to reach each column by, with any column named `rowid` renamed out
 * of the way of DuckDB's own row number, which it would otherwise hide.
 *
 * Renamed in `t` and left so: the profile is the last thing to read the table.
 * Its heading stays the column's name everywhere it is shown.
 */
async function freeRowid(conn: DuckDBConnection, names: string[]): Promise<string[]> {
  // DuckDB's terms: identifiers compare case-insensitively, folding ASCII only
  const taken = new Set(names.map(asciiLower))
  const reachable: string[] = []
  for (const name of names) {
    if (asciiLower(name) !== 'rowid') {
      reachable.push(name)
      continue
    }
    let free = 'rowid_'
    while (taken.has(free)) free += '_'
    taken.add(free)
    await conn.run(`ALTER TABLE t RENAME COLUMN ${sqlIdentifier(name)} TO ${sqlIdentifier(free)}`)
    reachable.push(free)
  }
  return reachable
}

/**
 * The clues of each text column. Counts are the schema's, over every row; the
 * lengths and shapes are measured over `sample`, and over every row for a
 * column the sample barely sees. A column with no value but blanks has a count
 * of nought.
 */
async function countClues(
  conn: DuckDBConnection,
  names: string[],
  described: ResourceColumn[],
  rowCount: number,
  text: number[],
  sample: string
): Promise<Map<number, TextColumnClues>> {
  const parts = (i: number) => {
    const x = value(names[i])
    return [
      `count(${x}) AS c${i}_sampled`,
      `avg(length(${x})) AS c${i}_avgLength`,
      `min(length(${x})) AS c${i}_minLength`,
      `max(length(${x})) AS c${i}_maxLength`,
      `avg(length(regexp_replace(${x}, '[^0-9０-９]', '', 'g'))::DOUBLE / length(${x})) AS c${i}_digitChars`,
      ...Object.entries(CLUES).map(
        ([clue, { full, re }]) =>
          `avg(${full ? 'regexp_full_match' : 'regexp_matches'}(${x}, ${sqlLiteral(re)})::INTEGER) AS c${i}_${clue}`
      ),
    ]
  }
  const present = (i: number) => rowCount - described[i].nullCount
  const row = await aggregateByColumn(conn, text, parts, sample)
  if (sample !== 't') {
    const thin = text.filter((i) => {
      const sampled = Number(row[`c${i}_sampled`])
      return sampled < SHAPE_SAMPLE_MIN_VALUES && sampled < present(i)
    })
    Object.assign(row, await aggregateByColumn(conn, thin, parts))
  }

  const measured = ['avgLength', 'minLength', 'maxLength', 'digitChars', ...Object.keys(CLUES)]
  return new Map(
    text.map((i) => {
      const clues = Object.fromEntries(measured.map((k) => [k, Number(row[`c${i}_${k}`] ?? 0)]))
      const blank = Number(row[`c${i}_sampled`]) === 0
      return [
        i,
        {
          ...clues,
          count: blank ? 0 : present(i),
          distinct: described[i].distinctCount ?? 0,
        } as TextColumnClues,
      ]
    })
  )
}

/** The values that are not numbers as written, most frequent first. */
async function notPlainNumbers(
  conn: DuckDBConnection,
  name: string,
  stride: number
): Promise<string[]> {
  const x = value(name)
  const rows = (
    await conn.runAndReadAll(`
      SELECT ${x} AS v FROM t
      WHERE rowid % ${stride} = 0
        AND ${x} IS NOT NULL AND NOT regexp_full_match(${x}, ${sqlLiteral(PLAIN_NUMBER)})
      GROUP BY 1 ORDER BY count(*) DESC, min(rowid) LIMIT ${NUMBER_EXAMPLES}`)
  ).getRowObjectsJson() as { v: string }[]
  return rows.map((r) => r.v)
}

/**
 * Every distinct value of the listed columns, once: how many rows hold it and
 * the first of them. Both the kept values and the artifact are read from here,
 * in one order — most frequent first, then first to appear.
 */
async function countValues(
  conn: DuckDBConnection,
  names: string[],
  listed: number[]
): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE profile_values
    (ord INTEGER, text VARCHAR, count BIGINT, "row" BIGINT)`)
  if (listed.length === 0) return
  const selects = listed.map((i) => {
    const x = value(names[i])
    return `SELECT ${i}, ${x}, count(*), min(rowid) + 1 FROM t WHERE ${x} IS NOT NULL GROUP BY ${x}`
  })
  await conn.run(`INSERT INTO profile_values ${selects.join(' UNION ALL ')}`)
}

/** The {@link COLUMN_VALUES_KEPT} most frequent values of each listed column. */
async function mostFrequentValues(conn: DuckDBConnection): Promise<Map<number, string[]>> {
  const rows = (
    await conn.runAndReadAll(`
      SELECT ord, text FROM profile_values
      QUALIFY row_number() OVER (PARTITION BY ord ORDER BY count DESC, "row") <= ${COLUMN_VALUES_KEPT}
      ORDER BY ord, count DESC, "row"`)
  ).getRowObjectsJson() as { ord: number; text: string }[]
  const lists = new Map<number, string[]>()
  for (const r of rows) {
    const ord = Number(r.ord)
    const list = lists.get(ord)
    if (list) list.push(r.text)
    else lists.set(ord, [r.text])
  }
  return lists
}

/**
 * Write the artifact (ADR-063 §決定 3・4): every value counted above, then a
 * sentence per row of the `sentence` columns in row order — the context, then
 * the free text — for each row with free text in it.
 * Written by DuckDB straight to disk, since a column of names runs as long as
 * the file.
 *
 * @returns the distinct sentences left out at {@link TABLE_SENTENCES_MAX_BYTES}.
 */
async function writeProfile(
  conn: DuckDBConnection,
  described: ResourceColumn[],
  names: string[],
  sentence: number[],
  free: number[],
  path: string
): Promise<number> {
  const parts = [`SELECT 0 AS part, ord, 'value' AS kind, text, count, "row" FROM profile_values`]
  let omitted = 0
  if (free.length > 0) {
    // `名前: 値` per column, the empty ones skipped by concat_ws
    const text = `concat_ws(' / ', ${sentence
      .map((i) => `${sqlLiteral(`${described[i].name}: `)} || ${value(names[i])}`)
      .join(', ')})`
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE profile_sentences AS
      SELECT text, count, "row", sum(strlen(text)) OVER (ORDER BY "row") AS bytes FROM (
        SELECT ${text} AS text, count(*) AS count, min(rowid) + 1 AS "row" FROM t
        WHERE coalesce(${free.map((i) => value(names[i])).join(', ')}) IS NOT NULL
        GROUP BY 1
      )`)
    const [counted] = (
      await conn.runAndReadAll(`
        SELECT count(*) AS omitted FROM profile_sentences
        WHERE bytes > ${TABLE_SENTENCES_MAX_BYTES}`)
    ).getRowObjectsJson() as { omitted: unknown }[]
    omitted = Number(counted.omitted)
    parts.push(`
      SELECT 1, 0, 'sentence', text, count, "row" FROM profile_sentences
      WHERE bytes <= ${TABLE_SENTENCES_MAX_BYTES}`)
  }

  // Headings by position, joined back in at the end: a heading is arbitrary
  // text and never goes into SQL as anything but a literal. zstd rather than
  // gzip: written in a fifth of the time and read in under two thirds, at the
  // same memory (ADR-063 試行).
  const headings = described.map((c, i) => `(${i}, ${sqlLiteral(c.name)})`).join(', ')
  await conn.run(`
    COPY (
      SELECT p.kind, h.name AS "column", p.text, p.count, p."row"
      FROM (${parts.join(' UNION ALL ')}) p
      LEFT JOIN (VALUES ${headings}) h(ord, name) ON p.kind = 'value' AND h.ord = p.ord
      ORDER BY p.part, p.ord, CASE WHEN p.part = 0 THEN -p.count END, p."row"
    ) TO ${sqlLiteral(path)} (FORMAT json, COMPRESSION zstd)`)
  return omitted
}
