/**
 * Version diff over DuckLake snapshots (ADR-043 layer 2 / Phase ii).
 *
 * **Both stages compare the two endpoints, never the change feed** — events
 * double-count an inclusive start and never cancel out over a range, so a row
 * that changed and changed back reads as a change (spec §7, measured).
 *
 * Given a key both ends share, rows are matched by it and an edit is one
 * changed row. Without one they are compared by their whole content, so an edit
 * is one addition and one removal — deliberate, because there is then no way to
 * tell an edit from an unrelated add plus remove, and inventing a
 * correspondence would fabricate history.
 */
import type { SchemaDiff, VersionDiff } from '@kukan/shared'
import type { LakeColumn } from './columns'
import { describeColumns, sameColumns } from './columns'
import type { LakeRow, LakeSession } from './connection'
import { keyMatchSql, valuesDifferSql } from './keyed-load'
import { sqlIdentifier } from './sql'
import { lakeTableAt as at, lakeTableRef } from './table'

/** Rows shown from each side; enough to recognize the change, not to browse it. */
const SAMPLE_LIMIT = 5

/**
 * Characters kept per sampled cell. Truncation happens in SQL rather than after
 * the rows reach JavaScript: nothing bounds the width of a CSV cell, and a row
 * materialized into JS objects is outside DuckDB's memory_limit — so trimming
 * afterwards would cap the response while leaving the peak unbounded.
 */
const SAMPLE_CELL_CHARS = 512

/**
 * Projection that trims wide cells. Only VARCHAR is unbounded — ADR-029 infers
 * integer/float/boolean/string, and the first three are fixed width.
 */
function sampleProjection(
  columns: LakeColumn[],
  read: (name: string) => string = sqlIdentifier,
  alias: (name: string) => string = sqlIdentifier
): string {
  return columns
    .map(({ name, type }) => {
      const id = alias(name)
      const value = read(name)
      if (type !== 'VARCHAR') return `${value} AS ${id}`
      return (
        `CASE WHEN length(${value}) > ${SAMPLE_CELL_CHARS} ` +
        `THEN left(${value}, ${SAMPLE_CELL_CHARS}) || '…' ELSE ${value} END AS ${id}`
      )
    })
    .join(', ')
}

function diffSchemas(from: LakeColumn[], to: LakeColumn[]): SchemaDiff {
  const fromByName = new Map(from.map((c) => [c.name, c]))
  const toByName = new Map(to.map((c) => [c.name, c]))
  return {
    added: to.filter((c) => !fromByName.has(c.name)),
    removed: from.filter((c) => !toByName.has(c.name)),
    retyped: from
      .filter((c) => toByName.get(c.name) && toByName.get(c.name)!.type !== c.type)
      .map((c) => ({ name: c.name, from: c.type, to: toByName.get(c.name)!.type })),
  }
}

/**
 * A column name no user column can shadow. CSV headers become column names, so
 * `__net` is not off-limits to a dataset; `SELECT *, 1 AS __net` against a table
 * that already has one is a duplicate-name error.
 */
function markerName(columns: LakeColumn[], base: string): string {
  // `startsWith`, not equality: the same answer serves a bare marker column and
  // a prefix for aliases derived from one, and the stronger test gives both —
  // a string no name begins with is also one no name equals.
  let name = base
  while (columns.some((c) => c.name.startsWith(name))) name += '_'
  return name
}

/**
 * One statement answering both "how many rows moved" and "show me a few".
 *
 * The two snapshots are stacked with a +1/-1 marker and grouped by the whole
 * row, so a row's net marker sum is how many copies were added (positive) or
 * removed (negative). That is `EXCEPT ALL` in both directions — duplicates
 * counted individually, NULLs matching — from a single pass, where the four
 * `EXCEPT ALL` scans it replaces each re-read both snapshots in full.
 *
 * The totals ride along as window sums so the counts need no second pass, and
 * `QUALIFY` caps what crosses into JavaScript at {@link SAMPLE_LIMIT} rows per
 * side: the grouped set is as large as the diff, which for a wholesale
 * replacement is the whole table.
 *
 * Sampled rows are the distinct contents that moved. `EXCEPT ALL` listed one
 * row three times when three copies were added, spending the sample budget on
 * repetition; the counts already say how many.
 *
 * @param fromRef - `FROM` clause for the older side, `toRef` for the newer.
 */
export function buildDiffQuery(
  fromRef: string,
  toRef: string,
  columns: LakeColumn[]
): { sql: string; net: string; total: string } {
  const net = markerName(columns, '__net')
  const total = markerName(columns, '__total')
  const cols = columns.map((c) => sqlIdentifier(c.name)).join(', ')

  return {
    net,
    total,
    sql: `
      WITH grouped AS (
        SELECT ${cols}, sum(${net}) AS ${net}
        FROM (
          SELECT ${cols}, 1 AS ${net} FROM ${toRef}
          UNION ALL
          SELECT ${cols}, -1 AS ${net} FROM ${fromRef}
        )
        GROUP BY ${cols}
        HAVING sum(${net}) <> 0
      )
      SELECT ${net}, sum(abs(${net})) OVER (PARTITION BY ${net} > 0) AS ${total},
             ${sampleProjection(columns)}
      FROM grouped
      QUALIFY row_number() OVER (PARTITION BY ${net} > 0) <= ${SAMPLE_LIMIT}
    `,
  }
}

/**
 * The bookkeeping columns the keyed query rides along with the sample, named so
 * no user column can shadow them (see {@link markerName}). Passed as a unit
 * because the query builds them and only the split understands them.
 */
export interface KeyedDiffMarkers {
  /** Which of added / removed / changed the row is. */
  kind: string
  /** How many rows of that kind there are, repeated on every row. */
  total: string
  /** Prefix of the columns holding the older side's value. */
  before: string
  /** Prefix of the flags saying whether that column's value moved. */
  moved: string
}

/**
 * One statement for the keyed diff: what each key did, and a few of each.
 *
 * A `FULL OUTER JOIN` on the key puts the two versions of a row side by side —
 * a key only `to` has is an addition, only `from` a removal, and one both hold
 * whose other columns differ is a change. The `WHERE` drops the rows that did
 * nothing, which is most of them.
 *
 * `IS DISTINCT FROM` rather than `<>`, so a value that became null (or stopped
 * being one) is a change rather than an unknown. Key columns are never null —
 * the ingest refuses a version whose key holds one (spec §6.6) — which is what
 * lets the join's own null test say which side a row came from.
 *
 * The totals ride along as window counts and `QUALIFY` caps what crosses into
 * JavaScript, the same shape the keyless query uses and for the same reason:
 * the set is as large as the diff. **The sample projection sits below the
 * window on purpose** — above it, the window buffers untruncated cells for every
 * changed row rather than 512-character ones, which runs out of the query's
 * memory cap on a table the ingest would accept (measured).
 *
 * Each side is wrapped in a sub-select because `AT (VERSION => n)` takes no
 * alias of its own, and the join needs one to say which side a column is from.
 */
export function buildKeyedDiffQuery(
  fromRef: string,
  toRef: string,
  columns: LakeColumn[],
  key: string[]
): { sql: string; markers: KeyedDiffMarkers } {
  const kind = markerName(columns, '__kind')
  const total = markerName(columns, '__total')
  const before = markerName(columns, '__before_')
  const moved = markerName(columns, '__moved_')
  const priorColumns = columns.filter((c) => !key.includes(c.name))
  const values = priorColumns.map((c) => c.name)
  // The load's own predicates, so "the same row" and "this row changed" cannot
  // drift apart: a changed row is by construction one the load's `WHEN MATCHED`
  // would have updated (spec §7).
  const on = keyMatchSql(key, 'f', 't')
  const changed = valuesDifferSql(values, 'f', 't')
  const absent = (side: string) => `${side}.${sqlIdentifier(key[0])} IS NULL`
  // Whichever side holds the row: `to` for an addition or a change, `from` for
  // a removal. Not `COALESCE`, which would take the other side's value for a
  // column that is null on this one.
  const read = (name: string) =>
    `CASE WHEN ${absent('t')} THEN f.${sqlIdentifier(name)} ELSE t.${sqlIdentifier(name)} END`

  // The side a changed row came from, for the columns that can differ. No guard
  // for the other kinds: on a full outer join an added row's `f` is already all
  // null, and a removed row's prior half is dropped rather than read.
  const prior = sampleProjection(
    priorColumns,
    (name) => `f.${sqlIdentifier(name)}`,
    (name) => sqlIdentifier(`${before}${name}`)
  )
  // Which columns actually moved, decided here rather than by the reader. The
  // projection beside this one truncates a wide cell, so two long values
  // differing past the cut arrive identical — and a cell that moved would be
  // shown as one that did not. One boolean per column, which is what the window
  // below buffers per changed row; the truncated values it already carries are
  // three orders of magnitude wider.
  const movedFlags = priorColumns
    .map(
      ({ name }) =>
        `f.${sqlIdentifier(name)} IS DISTINCT FROM t.${sqlIdentifier(name)} ` +
        `AS ${sqlIdentifier(`${moved}${name}`)}`
    )
    .join(', ')

  return {
    markers: { kind, total, before, moved },
    sql: `
      WITH joined AS (
        SELECT CASE WHEN ${absent('f')} THEN 'added'
                    WHEN ${absent('t')} THEN 'removed'
                    ELSE 'changed' END AS ${kind},
               ${sampleProjection(columns, read)}${
                 priorColumns.length === 0 ? '' : `, ${prior}, ${movedFlags}`
               }
        FROM (SELECT * FROM ${fromRef}) f FULL OUTER JOIN (SELECT * FROM ${toRef}) t ON ${on}
        WHERE ${absent('f')} OR ${absent('t')}${changed === null ? '' : ` OR (${changed})`}
      )
      SELECT ${kind}, count(*) OVER (PARTITION BY ${kind}) AS ${total}, * EXCLUDE (${kind})
      FROM joined
      QUALIFY row_number() OVER (PARTITION BY ${kind}) <= ${SAMPLE_LIMIT}
    `,
  }
}

/** Fold the keyed rows into the diff, dropping the bookkeeping columns. */
export function splitKeyedDiffRows(rows: LakeRow[], markers: KeyedDiffMarkers): VersionDiff {
  const { kind, total, before, moved } = markers
  const diff = {
    schemaChanged: false as const,
    keyed: true as const,
    addedRows: 0,
    removedRows: 0,
    changedRows: 0,
    sampleAdded: [] as LakeRow[],
    sampleRemoved: [] as LakeRow[],
    sampleChangedAfter: [] as LakeRow[],
    sampleChangedBefore: [] as LakeRow[],
  }

  /** The two sides a row arrives interleaved as, told apart by the prefix. */
  const split = (row: LakeRow) => {
    const after: LakeRow = {}
    const held: LakeRow = {}
    const movedColumns = new Set<string>()
    for (const [column, value] of Object.entries(row)) {
      if (column === kind || column === total) continue
      if (column.startsWith(moved)) {
        if (value === true) movedColumns.add(column.slice(moved.length))
      } else if (column.startsWith(before)) held[column.slice(before.length)] = value
      else after[column] = value
    }
    // The before side keeps only what moved — a column absent from it is one
    // the reader must not mark, and it cannot decide that from the truncated
    // values it is being sent.
    const prior: LakeRow = {}
    for (const column of Object.keys(held)) {
      if (movedColumns.has(column)) prior[column] = held[column]
    }
    return { after, prior }
  }

  for (const row of rows) {
    const count = Number(row[total])
    const { after, prior } = split(row)
    if (row[kind] === 'added') {
      diff.addedRows = count
      diff.sampleAdded.push(after)
    } else if (row[kind] === 'removed') {
      diff.removedRows = count
      diff.sampleRemoved.push(after)
    } else {
      diff.changedRows = count
      diff.sampleChangedAfter.push(after)
      diff.sampleChangedBefore.push(prior)
    }
  }

  return diff
}

/**
 * Diff two snapshots of one resource's table.
 *
 * @param key - the key **both ends were loaded under**, or null for none. Two
 *   versions read under different keys degrade to the keyless comparison (spec
 *   §7): rows counted as changed under one rule and not the other belong to
 *   neither. Which it is rests on the version rows, so the caller resolves it —
 *   the ingest and the purge's step-down ask the same question of the same two
 *   lists.
 */
export async function diffVersions(
  session: LakeSession,
  opts: { table: string; fromSnapshot: number; toSnapshot: number; key?: string[] | null }
): Promise<VersionDiff> {
  const ref = lakeTableRef(opts.table)
  const { fromSnapshot, toSnapshot } = opts

  const [fromCols, toCols] = await Promise.all([
    describeColumns(session, at(ref, fromSnapshot)),
    describeColumns(session, at(ref, toSnapshot)),
  ])

  // Columns moved: the two versions aren't row-comparable — neither comparison
  // has anything to line up, whichever way rows would be matched — so report the
  // schema change and stop, which is §7-3's third tier.
  // `sameColumns` is positional, so a pure reorder lands here too, and its
  // schemaDiff is empty: no column was added, removed, or retyped, but the rows
  // still cannot be lined up.
  if (!sameColumns(fromCols, toCols)) {
    return { schemaChanged: true, schemaDiff: diffSchemas(fromCols, toCols) }
  }

  const from = at(ref, fromSnapshot)
  const to = at(ref, toSnapshot)
  if (opts.key?.length) {
    const { sql, markers } = buildKeyedDiffQuery(from, to, toCols, opts.key)
    return splitKeyedDiffRows(await session.rows(sql), markers)
  }

  const { sql, net, total } = buildDiffQuery(from, to, toCols)
  return splitDiffRows(await session.rows(sql), net, total)
}

/** Fold the sampled rows into the diff, dropping the bookkeeping columns. */
export function splitDiffRows(rows: LakeRow[], net: string, total: string): VersionDiff {
  const diff = {
    schemaChanged: false as const,
    keyed: false as const,
    addedRows: 0,
    removedRows: 0,
    sampleAdded: [] as LakeRow[],
    sampleRemoved: [] as LakeRow[],
  }

  for (const row of rows) {
    const added = Number(row[net]) > 0
    const { [net]: _net, [total]: _total, ...content } = row
    if (added) {
      diff.addedRows = Number(row[total])
      diff.sampleAdded.push(content)
    } else {
      diff.removedRows = Number(row[total])
      diff.sampleRemoved.push(content)
    }
  }

  return diff
}
