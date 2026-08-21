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

export interface SchemaDiff {
  added: LakeColumn[]
  removed: LakeColumn[]
  retyped: { name: string; from: string; to: string }[]
}

/**
 * Either the columns lined up and the rows were compared, or they did not and
 * only the schema change is reported. A union rather than one shape with nulls,
 * so neither side carries filler the other has to guard against.
 */
export type VersionDiff =
  | { schemaChanged: true; schemaDiff: SchemaDiff }
  | {
      schemaChanged: false
      /**
       * Whether rows were identified by a declared primary key.
       *
       * False here: the rows were compared whole, so an edited row is one
       * addition and one removal and no count of edits exists. Stated rather
       * than left to be inferred from an absent `changedRows` — absence would
       * mean both "not measured" and "measured zero", and a reader picking the
       * wrong one reports edits that did not happen or none where there were
       * some.
       */
      keyed: false
      /** Rows in `to` that are absent from `from`, and the converse. */
      addedRows: number
      removedRows: number
      sampleAdded: LakeRow[]
      sampleRemoved: LakeRow[]
    }
  | {
      schemaChanged: false
      /**
       * The rows were matched by a key both ends were loaded under, so an edit
       * is one changed row rather than an addition and a removal.
       */
      keyed: true
      /** Keys in `to` that `from` did not have, and the converse. */
      addedRows: number
      removedRows: number
      /** Keys both hold, whose other columns differ. */
      changedRows: number
      sampleAdded: LakeRow[]
      sampleRemoved: LakeRow[]
      /**
       * The changed rows **as `to` holds them** — the name says which side,
       * because carrying both would double a projection that is evaluated over
       * every changed row before the sample is cut, for a before/after view the
       * dashboard does not yet offer (spec §7.1). Adding the other side later
       * is then a new field rather than a change of this one's shape.
       */
      sampleChangedAfter: LakeRow[]
    }

/**
 * Projection that trims wide cells. Only VARCHAR is unbounded — ADR-029 infers
 * integer/float/boolean/string, and the first three are fixed width.
 */
function sampleProjection(
  columns: LakeColumn[],
  read: (name: string) => string = sqlIdentifier
): string {
  return columns
    .map(({ name, type }) => {
      const id = sqlIdentifier(name)
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
  const taken = new Set(columns.map((c) => c.name))
  let name = base
  while (taken.has(name)) name += '_'
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
): { sql: string; kind: string; total: string } {
  const kind = markerName(columns, '__kind')
  const total = markerName(columns, '__total')
  const values = columns.filter((c) => !key.includes(c.name)).map((c) => c.name)
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

  return {
    kind,
    total,
    sql: `
      WITH joined AS (
        SELECT CASE WHEN ${absent('f')} THEN 'added'
                    WHEN ${absent('t')} THEN 'removed'
                    ELSE 'changed' END AS ${kind},
               ${sampleProjection(columns, read)}
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
export function splitKeyedDiffRows(rows: LakeRow[], kind: string, total: string): VersionDiff {
  const diff = {
    schemaChanged: false as const,
    keyed: true as const,
    addedRows: 0,
    removedRows: 0,
    changedRows: 0,
    sampleAdded: [] as LakeRow[],
    sampleRemoved: [] as LakeRow[],
    sampleChangedAfter: [] as LakeRow[],
  }

  for (const row of rows) {
    const { [kind]: which, [total]: count, ...content } = row
    if (which === 'added') {
      diff.addedRows = Number(count)
      diff.sampleAdded.push(content)
    } else if (which === 'removed') {
      diff.removedRows = Number(count)
      diff.sampleRemoved.push(content)
    } else {
      diff.changedRows = Number(count)
      diff.sampleChangedAfter.push(content)
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
    const { sql, kind, total } = buildKeyedDiffQuery(from, to, toCols, opts.key)
    return splitKeyedDiffRows(await session.rows(sql), kind, total)
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
