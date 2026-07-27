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
 * Diff two snapshots of one resource's table.
 *
 * Row counts use `EXCEPT ALL` rather than `EXCEPT` so duplicate rows are counted
 * individually — with `EXCEPT`, dropping one of three identical rows would
 * register as no change at all.
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

  const onlyIn = (a: number, b: number) =>
    `SELECT * FROM ${at(ref, a)} EXCEPT ALL SELECT * FROM ${at(ref, b)}`
  const countOf = async (sql: string): Promise<number> => {
    const [row] = await session.rows(`SELECT count(*) AS c FROM (${sql})`)
    return Number(row.c)
  }

  const addedSql = onlyIn(toSnapshot, fromSnapshot)
  const removedSql = onlyIn(fromSnapshot, toSnapshot)
  const projection = sampleProjection(toCols)
  const sampleOf = (sql: string) =>
    session.rows(`SELECT ${projection} FROM (${sql}) LIMIT ${SAMPLE_LIMIT}`)
  const [addedRows, removedRows, sampleAdded, sampleRemoved] = await Promise.all([
    countOf(addedSql),
    countOf(removedSql),
    sampleOf(addedSql),
    sampleOf(removedSql),
  ])

  return { schemaChanged: false, addedRows, removedRows, sampleAdded, sampleRemoved }
}
