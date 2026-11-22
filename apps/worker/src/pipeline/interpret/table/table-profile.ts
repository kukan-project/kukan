/**
 * KUKAN Pipeline — the table profile (ADR-063 §決定 3・4), of a CSV or JSON table alike
 *
 * Counts, over the interpreted table, what the role rules read; keeps the most
 * frequent values of the columns a search finds a table by; and writes the
 * profile artifact the index is built from. Done where the table already is —
 * the interpretation's DuckDB — so nothing reads the CSV again.
 */

import type { DuckDBConnection } from '@duckdb/node-api'
import { NO_VALUE_MARK, isNoValueMark, readsAsNumber, sqlIdentifier, sqlLiteral } from '@kukan/lake'
import {
  COLUMN_VALUES_KEPT,
  TABLE_SENTENCES_MAX_BYTES,
  vocabularySearchFields,
} from '@kukan/shared'
import type { ColumnProfile, ColumnRoleBasis, ResourceColumn, TableProfile } from '@kukan/shared'
import {
  INFERENCE_RULES,
  corroborate,
  judgeColumn,
  judgeNamesByCodes,
  nameSchemes,
  outranks,
  registryFor,
  sharedNames,
  verdictOf,
  type ColumnInference,
  type SettledVerdict,
} from '@kukan/vocabulary'
import { STATS_COLUMNS_PER_QUERY } from '@/config'
import { aggregateByColumn } from './column-batches'
import type { ProfileRequest } from './write-table'
import { listsValues, readsVocabulary, textColumnRole, type TextColumnClues } from './column-role'

/** Values shown for why a `numeric-text` column is not a number. */
const NUMBER_EXAMPLES = 3

/** Category columns put in front of a sentence, the least varied first. */
const SENTENCE_CONTEXT_COLUMNS = 3

/**
 * A number as written: a sign (`▲` `△` for minus), a currency, brackets, and
 * digits in groups split by commas, dots, apostrophes or spaces — any
 * country's way, `1,234.5`, `1.234,5`, `1 234`, `1'234` — full-width or not,
 * with an exponent or without.
 */
const NUMBER =
  "[-−‐－▲△+＋]?\\s*[¥￥$＄€£₩]?\\s*[(（]?[0-9０-９]+([,，.．'’ ][0-9０-９]+)*([eE][-+]?[0-9]+)?[)）]?"
/**
 * What may follow a number, a unit by its shape rather than a list of every
 * language's: a percent or a currency; up to four letters of Chinese,
 * Japanese or Korean (`円`, `世帯`, `か月`, `万`, `명`); lower-case Latin ones
 * (`kg`, `hrs`, a flag like `p`), or any after a space (`5 KB`, `12 USD`). Not
 * an upper-case run touching the digits, which is a code (`1A`, `2LDK`).
 */
const UNIT =
  '(\\s*[%％‰¥￥$＄€£₩]|\\s*[\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}ヶ㎡℃°]{1,4}|' +
  '\\s*[a-zµ°][a-zA-Z0-9²³/.]{0,5}|\\s+[A-Za-z][A-Za-z0-9²³/.]{0,5})'
/** Units that make a number a place or a name: an address, a room, a floor plan. */
const NOT_UNIT = '(丁目|番地?|号(室|棟|機|館)?|階|S?L?DK)'

/**
 * One regex per clue, matched against the trimmed value. RE2 syntax; `full`
 * means the whole value has to match. Written from the spike's misses: dates
 * in eras or ending at the month, phone numbers in brackets, numbers with
 * full-width digits.
 *
 * A date separated by dots needs all three parts: `1234.56` is a number.
 */
export const CLUES = {
  ascii: { full: true, re: '[0-9A-Za-z._/:\\-]+' },
  digits: { full: true, re: '[0-9０-９]+' },
  digit: { full: false, re: '[0-9０-９]' },
  // A number never starts with a zero, so digits that do are a code the type left as text
  leadingZero: { full: true, re: '[0０][0-9０-９]+' },
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
  number: { full: true, re: `${NUMBER}${UNIT}?` },
  // Taken off `number`: a unit that makes the value a place or a name
  notNumber: { full: true, re: `${NUMBER}\\s*${NOT_UNIT}` },
  mark: { full: true, re: NO_VALUE_MARK },
} satisfies Record<string, { full: boolean; re: string }>

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

/** The trimmed value of a column, with blank as missing. */
const value = (name: string, { cast = false } = {}) =>
  `nullif(trim(${cast ? `CAST(${sqlIdentifier(name)} AS VARCHAR)` : sqlIdentifier(name)}), '')`

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
  { path, vocabularyPacks, roleOverrides }: ProfileRequest
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
      Object.assign(decision.roleBasis, await numberCounts(conn, names[i]))
    }
    profiled.push(decision)
  }

  // Before the values are listed: a column found to hold codes is an
  // identifier, and its values then stay out of the artifact and the index
  const registry =
    vocabularyPacks.length > 0
      ? await readVocabulary(conn, names, described, profiled, vocabularyPacks)
      : undefined
  const search = registry ? vocabularySearchFields(profiled.map((c) => c.vocabulary)) : {}

  // A person's role over the rules', vocabulary's included (ADR-063 §決定 5),
  // and before the values are listed, which follow the role. Text columns
  // only: a name the table no longer has, or now types, is left to its rules
  for (const [i, column] of described.entries()) {
    // Own keys only: a column named `constructor` is not the prototype's
    const role =
      roleOverrides && Object.hasOwn(roleOverrides, column.name)
        ? roleOverrides[column.name]
        : undefined
    if (!role || !clues.has(i) || role === profiled[i].role) continue
    const { role: was, roleBasis } = profiled[i]
    profiled[i] = {
      ...profiled[i],
      role,
      roleBasis: {
        rule: 'override',
        ...(role === 'numeric-text' && (await numberCounts(conn, names[i]))),
      },
      inferred: { role: was, roleBasis },
    }
  }
  const done = {
    columns: profiled,
    ...(registry && { registry }),
    ...(Object.keys(search).length > 0 && { search }),
  }

  const listed = profiled.flatMap((c, i) => (listsValues(c.role) ? [i] : []))
  const free = described.flatMap((_, i) => (profiled[i].role === 'free-text' ? [i] : []))
  if (listed.length === 0 && free.length === 0) return done

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
  return { ...done, path, ...(sentencesOmitted > 0 && { sentencesOmitted }) }
}

/**
 * What each column means against the site's enabled packs (ADR-073 §決定 4・5),
 * written onto its profile, and the registry state it was worked out under —
 * none where no enabled pack is one this release ships.
 *
 * Text columns are read, and integer columns within the span the registry's
 * codes are written in: an integer column is a code column whose values had no
 * leading zero to keep them text, and reads back as the digits it was written
 * with. Prose, links, phone numbers and dates are not read (`readsVocabulary`).
 *
 * A column decided to hold codes becomes an identifier; one of names keeps its
 * role, its values being what a search looks for. A column more than one
 * scheme reaches is left undecided: its vocabulary names the candidates, and
 * its role is not changed on one of their say-so.
 *
 * A short code column its values and heading leave unsettled is taken only
 * where a column of names in the same table bears it out (`corroborate`).
 * Two-digit codes typed as integers fall below the registry's span and are
 * not read: a column with no leading zero holds no prefecture before 10.
 */
async function readVocabulary(
  conn: DuckDBConnection,
  names: string[],
  described: ResourceColumn[],
  profiled: ColumnProfile[],
  packs: string[]
): Promise<string | undefined> {
  const registry = await registryFor(packs)
  // No pack this release ships reads nothing, and records no state: what the
  // refresh takes a site with no pack enabled to have
  if (registry.schemes.length === 0) return undefined
  const range = registry.integerRange
  const read = described.flatMap((c, i) => {
    const distinct = c.distinctCount ?? 0
    const inRange =
      c.type === 'string' ||
      (c.type === 'integer' &&
        range !== null &&
        c.stats !== undefined &&
        Number(c.stats.max) >= range.min &&
        Number(c.stats.min) <= range.max)
    return inRange &&
      distinct > 0 &&
      distinct <= INFERENCE_RULES.maxValues &&
      readsVocabulary(profiled[i])
      ? [i]
      : []
  })
  const row = await aggregateByColumn(conn, read, (i) => [
    `list(DISTINCT ${value(names[i], { cast: true })}) AS c${i}_values`,
  ])
  // Columns of codes, and columns that hold names of a scheme in part — read
  // pairwise below, each settling what the other cannot alone. A column of
  // codes is trusted once decided, or once a column of names bears it out
  const codeColumns = new Map<number, ColumnInference[]>()
  const trusted = new Set<ColumnInference>()
  const nameColumns = new Map<string, number[]>()
  const valuesOf = new Map<number, string[]>()
  for (const i of read) {
    const values = ((row[`c${i}_values`] as (string | null)[] | null) ?? []).filter(
      (v): v is string => v !== null
    )
    valuesOf.set(i, values)
    for (const scheme of nameSchemes(registry, values)) {
      ;(nameColumns.get(scheme) ?? nameColumns.set(scheme, []).get(scheme)!).push(i)
    }
    const verdict = judgeColumn(registry, values, {
      heading: described[i].name,
      integer: described[i].type === 'integer',
    })
    if (!verdict) continue
    if ('unconfirmed' in verdict) {
      codeColumns.set(i, verdict.unconfirmed)
      continue
    }
    if ('decided' in verdict && verdict.decided.kind === 'code') {
      codeColumns.set(i, [verdict.decided])
      trusted.add(verdict.decided)
    }
    profiled[i] = withVocabulary(profiled[i], verdict)
  }

  const compared = [...codeColumns].flatMap(([i, found]) =>
    [...new Set(found.flatMap((f) => nameColumns.get(f.scheme) ?? []))]
      .filter((j) => j !== i)
      .map((j) => ({ i, j, found: found.filter((f) => nameColumns.get(f.scheme)!.includes(j)) }))
  )
  if (compared.length === 0) return registry.state
  const used = [...new Set(compared.flatMap(({ i, j }) => [i, j]))]
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE vocabulary_sample AS ` +
      `SELECT ${used.map((k) => sqlIdentifier(names[k])).join(', ')} FROM t ` +
      `USING SAMPLE reservoir(${INFERENCE_RULES.corroboration.sampleRows} ROWS) REPEATABLE (0)`
  )
  // Pairs from a sample of rows, each batch judged and let go before the next.
  // A row with a name and no code is one too: its name still has to be one
  const readings: { i: number; j: number; codes: ColumnInference; names: ColumnInference }[] = []
  for (let start = 0; start < compared.length; start += STATS_COLUMNS_PER_QUERY) {
    const batch = compared.slice(start, start + STATS_COLUMNS_PER_QUERY)
    const lists = batch.map(({ i, j }, k) => `${pairList(names[i], names[j])} AS p${k}`)
    const [listed] = (
      await conn.runAndReadAll(`SELECT ${lists.join(', ')} FROM vocabulary_sample`)
    ).getRowObjectsJson() as Record<string, [string | null, string][] | null>[]
    for (const [k, { i, j, found }] of batch.entries()) {
      const pairs = listed[`p${k}`] ?? []
      for (const codes of found) {
        if (!trusted.has(codes) && corroborate(registry, codes, pairs)) trusted.add(codes)
        const names = judgeNamesByCodes(registry, codes, pairs)
        if (names) readings.push({ i, j, codes, names })
      }
    }
  }
  await conn.run('DROP TABLE vocabulary_sample')

  for (const [i, found] of codeColumns) {
    if (profiled[i].vocabulary) continue
    // Best first, as judged
    const [first, ...rest] = found.filter((f) => trusted.has(f))
    if (first) profiled[i] = withVocabulary(profiled[i], verdictOf([first, ...rest]))
  }
  // A reading by codes is judged on a sample, and what it records — its places
  // above all, which a search by area finds the table by — is read from every
  // row: the column's distinct values, and the rows of its shared names whole.
  // Taken only where that reading still holds
  for (const { i, j, codes } of readings) {
    const held = profiled[j].vocabulary
    // Read only by codes that stand; a decided column of codes stays one
    if (!trusted.has(codes) || (profiled[j].role === 'identifier' && held && !held.alternatives))
      continue
    const values = valuesOf.get(j) ?? []
    const shared = sharedNames(registry, codes.scheme, values)
    const [whole] =
      shared.length === 0
        ? [{ p: [] }]
        : ((
            await conn.runAndReadAll(`SELECT ${pairList(names[i], names[j], shared)} AS p FROM t`)
          ).getRowObjectsJson() as { p: [string | null, string][] | null }[])
    const pairs = [...(whole.p ?? []), ...values.map((v): [null, string] => [null, v])]
    const read = judgeNamesByCodes(registry, codes, pairs)
    if (!read || (held && !held.alternatives && !outranks(read, held))) continue
    profiled[j] = withVocabulary(profiled[j], { decided: read })
  }
  return registry.state
}

/**
 * The distinct (code, name) pairs of two columns, over the rows with a name —
 * those with no code too — or only the rows of the names given.
 */
function pairList(code: string, name: string, only?: string[]): string {
  const c = value(code, { cast: true })
  const n = value(name, { cast: true })
  const where = only ? `${n} IN (${only.map(sqlLiteral).join(', ')})` : `${n} IS NOT NULL`
  return `list(DISTINCT [${c}, ${n}]) FILTER (WHERE ${where})`
}

/** A column's profile with a verdict on it: a decided code is an identifier. */
function withVocabulary(column: ColumnProfile, verdict: SettledVerdict): ColumnProfile {
  const decided = 'decided' in verdict
  const [best, ...others] = decided ? [verdict.decided] : verdict.candidates
  return {
    ...column,
    ...(decided &&
      best.kind === 'code' && { role: 'identifier', roleBasis: { rule: 'vocabulary' } }),
    vocabulary: {
      concept: best.concept,
      pack: best.pack,
      scheme: best.scheme,
      representation: best.representation,
      share: best.share,
      ambiguous: best.ambiguous,
      levels: best.summary.levels,
      periods: best.summary.periods,
      narrowedBy: best.summary.narrowedBy,
      kind: best.kind,
      // What a search by area finds the table by: a decided reading only
      ...(decided && { places: best.places, roots: best.roots }),
      ...(!decided && {
        alternatives: others.map(({ concept, pack, scheme, representation }) => ({
          concept,
          pack,
          scheme,
          representation,
        })),
      }),
    },
  }
}

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/**
 * The names to reach each column by, with any column named `rowid` renamed out
 * of the way of DuckDB's own row number, which it would otherwise hide.
 *
 * Renamed in `t` and left so: the profile is the last thing to read the table,
 * and the settled types rebuild it under the old names. Its heading stays the
 * column's name everywhere it is shown.
 */
export async function freeRowid(conn: DuckDBConnection, names: string[]): Promise<string[]> {
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

    // `leadingZero` is asked whether there is one, not how many: a column of
    // digits the sample found none in is asked again over every row, where the
    // one `010006` that kept it text may sit
    const unseen = text.filter(
      (i) => Number(row[`c${i}_digits`]) >= 0.9 && Number(row[`c${i}_leadingZero`]) === 0
    )
    Object.assign(
      row,
      await aggregateByColumn(conn, unseen, (i) => [
        `bool_or(regexp_full_match(${value(names[i])}, ${sqlLiteral(CLUES.leadingZero.re)}))::INTEGER AS c${i}_leadingZero`,
      ])
    )
  }

  const measured = ['avgLength', 'minLength', 'maxLength', 'digitChars', ...Object.keys(CLUES)]
  return new Map(
    text.map((i) => {
      const clues = Object.fromEntries(measured.map((k) => [k, Number(row[`c${i}_${k}`] ?? 0)]))
      // Every value `notNumber` matches, `number` does too
      clues.number -= clues.notNumber
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

/**
 * What a `numeric-text` column holds, over every row: how many values are
 * numbers, marks, blank or else, and the commonest values a settled number
 * would not read — what a publisher has to mend (ADR-063 §決定 5).
 */
async function numberCounts(
  conn: DuckDBConnection,
  name: string
): Promise<Pick<ColumnRoleBasis, 'counts' | 'examples'>> {
  const x = value(name)
  const mark = isNoValueMark(x)
  const number =
    `regexp_full_match(${x}, ${sqlLiteral(CLUES.number.re)}) ` +
    `AND NOT regexp_full_match(${x}, ${sqlLiteral(CLUES.notNumber.re)})`
  const [row] = (
    await conn.runAndReadAll(`
      SELECT count(*) FILTER (WHERE ${x} IS NULL) AS blank,
        count(*) FILTER (WHERE ${mark}) AS marks,
        count(*) FILTER (WHERE ${number} AND NOT ${mark}) AS numbers,
        count(*) AS total
      FROM t`)
  ).getRowObjectsJson() as Record<string, string | number>[]
  const [blank, marks, numbers, total] = ['blank', 'marks', 'numbers', 'total'].map((k) =>
    Number(row[k])
  )
  const examples = (
    await conn.runAndReadAll(`
      SELECT ${x} AS v FROM t
      WHERE ${x} IS NOT NULL AND NOT ${mark} AND NOT ${readsAsNumber(x)}
      GROUP BY 1 ORDER BY count(*) DESC, min(rowid) LIMIT ${NUMBER_EXAMPLES}`)
  ).getRowObjectsJson() as { v: string }[]
  return {
    counts: { numbers, marks, blank, others: total - blank - marks - numbers },
    ...(examples.length > 0 && { examples: examples.map((r) => r.v) }),
  }
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
