/**
 * Version diff over DuckLake snapshots (ADR-043 layer 2 / Phase ii-a).
 *
 * ii-a is keyless, so rows are compared by their full content: a row present in
 * one version and not the other is an addition or a removal. An edited row
 * therefore shows up as one of each. That is deliberate — without a key there is
 * no way to tell an edit from an unrelated add plus remove, and inventing a
 * correspondence would fabricate history. Changed-row tracking arrives with
 * keyed MERGE in ii-b.
 */
import type { LakeColumn } from './columns'
import { describeColumns, sameColumns } from './columns'
import type { LakeRow, LakeSession } from './connection'
import { sqlIdentifier } from './sql'
import { lakeTableRef } from './table'

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
      /** Rows in `to` that are absent from `from`, and the converse. */
      addedRows: number
      removedRows: number
      sampleAdded: LakeRow[]
      sampleRemoved: LakeRow[]
    }

/** `FROM` clause reading the table as of one snapshot. */
function at(ref: string, snapshot: number): string {
  return `${ref} AT (VERSION => ${Math.trunc(snapshot)})`
}

/**
 * Projection that trims wide cells. Only VARCHAR is unbounded — ADR-029 infers
 * integer/float/boolean/string, and the first three are fixed width.
 */
function sampleProjection(columns: LakeColumn[]): string {
  return columns
    .map(({ name, type }) => {
      const id = sqlIdentifier(name)
      if (type !== 'VARCHAR') return id
      return (
        `CASE WHEN length(${id}) > ${SAMPLE_CELL_CHARS} ` +
        `THEN left(${id}, ${SAMPLE_CELL_CHARS}) || '…' ELSE ${id} END AS ${id}`
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
 * Diff two snapshots of one resource's table.
 */
export async function diffVersions(
  session: LakeSession,
  opts: { table: string; fromSnapshot: number; toSnapshot: number }
): Promise<VersionDiff> {
  const ref = lakeTableRef(opts.table)
  const { fromSnapshot, toSnapshot } = opts

  const [fromCols, toCols] = await Promise.all([
    describeColumns(session, at(ref, fromSnapshot)),
    describeColumns(session, at(ref, toSnapshot)),
  ])

  // Columns moved: the two versions aren't row-comparable (EXCEPT requires
  // matching shapes), so report the schema change and stop — §7-3's third tier.
  // `sameColumns` is positional, so a pure reorder lands here too, and its
  // schemaDiff is empty: no column was added, removed, or retyped, but the rows
  // still cannot be lined up.
  if (!sameColumns(fromCols, toCols)) {
    return { schemaChanged: true, schemaDiff: diffSchemas(fromCols, toCols) }
  }

  const { sql, net, total } = buildDiffQuery(at(ref, fromSnapshot), at(ref, toSnapshot), toCols)
  return splitDiffRows(await session.rows(sql), net, total)
}

/** Fold the sampled rows into the diff, dropping the bookkeeping columns. */
export function splitDiffRows(rows: LakeRow[], net: string, total: string): VersionDiff {
  const diff = {
    schemaChanged: false as const,
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
