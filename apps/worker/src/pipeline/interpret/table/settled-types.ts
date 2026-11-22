/**
 * Read a table's settled columns on the types a person settled (Versioning
 * ii-c §8.3).
 *
 * The columns arrive as text — the CSV reader is told to read them as VARCHAR,
 * the JSON reader hands them over as their written form — and are rebuilt here
 * with `TRY_CAST`, after everything that has to see the raw text (the sign-off
 * and footer rules). Reading them on the type directly would have the reader
 * refuse every row holding one value that does not convert, and with it the
 * whole file; a value that does not convert is left empty instead, counted and
 * shown, and the row stays.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import {
  settledExpression,
  settledFailures,
  settledMarks,
  sqlIdentifier,
  type SettledNote as LakeSettledNote,
  type SettledRead,
  type SettledRelation,
} from '@kukan/lake'
import {
  parseSettledType,
  settledTypesOf,
  type ResourceColumn,
  type ResourceColumnType,
  type ResourceSchema,
  type SettledTypeSpec,
} from '@kukan/shared'
import { freeRowid } from './table-profile'
import { describe, type Column } from './write-table'

/** What the previous version decided about a settled column. */
export type PreviousRead = SettledRead

/** What a version is read with: the settled types, and what the previous version decided. */
export interface SettledReading {
  /** Column name → the stored settled type (`"decimal"`, `"date:%d/%m/%Y"`). */
  types: Record<string, string>
  /**
   * What the previous version read these columns with, by name: a date format
   * that breaks a tie, and digits to fall back on where no value is readable.
   */
  previous?: Record<string, PreviousRead>
  /**
   * Read with what `previous` decided rather than falling back on it: the
   * version is being read again as it was read once — by the lake, which has
   * to load the table its preview shows — or as the version a revert goes
   * back to was read (§8.2). A column `previous` has nothing for is decided
   * from its values.
   */
  fixed?: true
}

/** What a schema's columns decided that a later reading falls back on, by name. */
export function previousReads(schema: ResourceSchema): Record<string, PreviousRead> {
  const reads: Record<string, PreviousRead> = {}
  for (const c of schema.columns) {
    if (c.dateFormat === undefined && !c.dateFormatUndecided && c.decimalPrecision === undefined) {
      continue
    }
    reads[c.name] = {
      ...(c.dateFormat !== undefined && { dateFormat: c.dateFormat }),
      ...(c.dateFormatUndecided && { dateFormatUndecided: true as const }),
      ...(c.decimalPrecision !== undefined && {
        decimalPrecision: c.decimalPrecision,
        decimalScale: c.decimalScale,
      }),
    }
  }
  return reads
}

/**
 * The reading for `types`, falling back on what `schema` decided — or, where
 * `fixed`, reading with it (§8.3).
 */
export function readingOf(
  types: Record<string, string>,
  schema: ResourceSchema | null,
  fixed?: true
): SettledReading {
  return { types, ...(schema && { previous: previousReads(schema), ...(fixed && { fixed }) }) }
}

/**
 * How to read a version with its frozen settled types: again as it was read,
 * with the formats and digits its schema records — or, where no reading has
 * recorded one, for the first time, falling back on the schema of the version
 * before it. Undefined where it froze none.
 */
export function versionReading(
  settledTypes: Record<string, string> | null,
  schema: ResourceSchema | null,
  previousSchema: ResourceSchema | null
): SettledReading | undefined {
  const types = settledTypesOf(settledTypes)
  if (!types) return undefined
  return schema ? readingOf(types, schema, true) : readingOf(types, previousSchema)
}

/** What a settled column adds to its schema entry. */
export type SettledNote = LakeSettledNote

/**
 * The settled columns `types` names that the table has, by the name the table
 * gives them. A name the table does not have is the caller's `missingSettled`.
 */
function settledSpecs(
  types: Record<string, string>,
  names: string[]
): Map<string, SettledTypeSpec> {
  const specs = new Map<string, SettledTypeSpec>()
  for (const name of names) {
    if (!Object.hasOwn(types, name)) continue
    const spec = parseSettledType(types[name])
    if (spec) specs.set(name, spec)
  }
  return specs
}

/** What reading the settled columns came to. */
export interface Settled {
  /** The table's columns as they now are. */
  columns: Column[]
  /** What each settled column came to, by name. */
  notes: Map<string, SettledNote>
  /** Settled names the table does not have (§8.3 step 1), sorted. */
  missing: string[]
}

/**
 * Rebuild table `t`'s settled columns on their types, and say what each one
 * came to. The columns must be text in `t`. Without `reading`, or with no
 * settled column in the table, nothing is read.
 *
 * @param inferred - what inference made of each settled column, by name.
 */
export async function settleColumns(
  conn: DuckDBConnection,
  columns: Column[],
  reading: SettledReading | undefined,
  inferred: Map<string, ResourceColumnType>
): Promise<Settled> {
  const types = reading?.types ?? {}
  const names = columns.map((c) => c.name)
  const missing = Object.keys(types)
    .filter((name) => !names.includes(name))
    .sort()
  const specs = settledSpecs(types, names)
  const notes = new Map<string, SettledNote>()
  if (specs.size === 0) return { columns, notes, missing }

  // The samples are numbered by DuckDB's rowid, which a column of that name hides
  const reachable = await freeRowid(conn, names)
  const rel: SettledRelation = {
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS(),
    from: 't',
    row: 'rowid',
  }
  const at = new Map(names.map((name, i) => [name, sqlIdentifier(reachable[i])]))
  const exprs = new Map<string, string>()
  for (const [name, spec] of specs) {
    const col = at.get(name)!
    const previous =
      reading?.previous && Object.hasOwn(reading.previous, name)
        ? reading.previous[name]
        : undefined
    const fixed = reading?.fixed === true
    // Read with the format the version was read with, as if the setting named it
    const read = await settledExpression(
      rel,
      col,
      fixed && previous?.dateFormat && !spec.format
        ? { ...spec, format: previous.dateFormat }
        : spec,
      previous,
      fixed
    )
    if (read.expr !== null) exprs.set(name, read.expr)
    notes.set(name, {
      settled: true,
      inferredType: inferred.get(name) ?? 'string',
      ...read.note,
      ...(read.expr !== null && (await settledFailures(rel, col, read.expr))),
      ...(read.expr !== null && (await settledMarks(rel, col, read.expr))),
    })
  }
  const renamed = reachable.some((name, i) => name !== names[i])
  if (exprs.size === 0 && !renamed) return { columns, notes, missing }

  // A new table rather than an ALTER per column: one pass, the rows in the
  // order they were in, and a column moved out of rowid's way named back
  const select = names
    .map((name) => `${exprs.get(name) ?? at.get(name)} AS ${sqlIdentifier(name)}`)
    .join(', ')
  await conn.run(`CREATE TABLE t_settled AS SELECT ${select} FROM t`)
  await conn.run('DROP TABLE t')
  await conn.run('ALTER TABLE t_settled RENAME TO t')
  return { columns: await describe(conn), notes, missing }
}

/** The schema's columns with what each settled one came to. */
export function withSettledNotes(
  described: ResourceColumn[],
  notes: Map<string, SettledNote>
): ResourceColumn[] {
  return described.map((column) => {
    const note = notes.get(column.name)
    return note ? { ...column, ...note } : column
  })
}
