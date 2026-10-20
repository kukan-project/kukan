/**
 * KUKAN Pipeline — JSON/GeoJSON interpretation on DuckDB (ADR-063 extension)
 *
 * Reads a JSON file off local disk as a table of records: a top-level array of
 * objects, one array under a single key (`{"dataset": [...]}`, which is how
 * BODIK publishes), or the `properties` of a GeoJSON FeatureCollection's
 * features. Nested objects become columns named by their path joined with `_`
 * (`contact_phone`) — a `.` would make the name no OData identifier (ADR-055);
 * arrays and values of no one type stay as JSON text in a column of their own.
 * Then it ends the way a CSV does (`writeTable`): the Parquet preview, the
 * column schema, the profile.
 *
 * A feature's `id` becomes a column `id` where any feature has one — its
 * natural key, outside `properties`. A Point's coordinates become two columns,
 * `geometry_lon` and `geometry_lat`:
 * a place is something a query filters on. A line's or a polygon's stay out —
 * they are most of the file's bytes, and a preview page or a feed page sized by
 * row group cannot carry them — and what is kept of them is which kinds of
 * shape the file holds (`ResourceSchema.geometryTypes`).
 *
 * A file in none of those shapes — a configuration object, a document of
 * nested sections, an array of strings — is `not-records`, and the content
 * index takes it as text, as before.
 */

import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { DuckDBConnection } from '@duckdb/node-api'
import { openDuckdb, sqlIdentifier, sqlLiteral } from '@kukan/lake'
import type { NoTableReason } from '@kukan/shared'
import {
  INTERPRET_MEMORY_LIMIT_MB,
  INTERPRET_THREADS,
  MAX_JSON_OBJECT_SIZE,
  MAX_TABLE_COLUMNS,
} from '@/config'
import { describe, writeTable, type Column, type InterpretedTableFile } from './write-table'

/** What reading the file produced nothing from. */
const refused = (reason: NoTableReason): InterpretedTableFile => ({
  schema: { rowCount: 0, columns: [] },
  reason,
})

/**
 * The reader could not make records of the file: not JSON, or JSON whose
 * values do not fit one set of columns. Anything else it raises — running out
 * of memory first of all — is the run's to fail on.
 */
const NOT_RECORDS = /Malformed JSON|JSON transform error|Could not convert|Duplicate name/

/** One value of the file — a record, or the whole of a file that is one object — past the cap. */
const TOO_LARGE = /maximum_object_size/

/**
 * What DuckDB raises of its own on a file nested too deep to lay out, anywhere
 * from the read to the flat table: its own memory limit, and the binder's bound
 * on how deep one expression goes. Settled, as the heavy process's bounds are —
 * reading the same file again ends the same way. A crash of DuckDB is not among
 * them: it can also be a passing fault, and `MAX_JSON_DEPTH` keeps the nesting
 * that causes one from reaching the reader at all.
 */
const OUT_OF_MEMORY = /Out of Memory Error/
const TOO_DEEP = /Max expression depth/

/**
 * The out-of-memory DuckDB raises when it cannot spill: the temp directory is
 * shared with other jobs' downloads, so full is a passing state, not the file's.
 */
const SPILL_FULL = /offload|max_temp_directory_size/

/** The reason an error raised while interpreting settles the file with, if it does. */
export function settledReason(err: unknown): NoTableReason | null {
  if (!(err instanceof Error)) return null
  if (OUT_OF_MEMORY.test(err.message)) return SPILL_FULL.test(err.message) ? null : 'out-of-memory'
  if (TOO_DEEP.test(err.message)) return 'not-records'
  return null
}

/**
 * How the reader settles the columns: over every record, as a CSV's are
 * (`sample_size = -1`) — by default it looks at the first 20,480, and a key or
 * a type that first appears after them is silently dropped. And an object of
 * many keys as the struct it is, never a MAP: past 200 keys the reader makes
 * one MAP column of it by default, which is no table.
 */
const READ_OPTIONS = 'sample_size = -1, map_inference_threshold = -1'

/**
 * Whether a JSON text is one object rather than an array, from its first byte
 * past a byte-order mark and whitespace — however much whitespace there is, so
 * the stream is read only as far as that byte. What it decides is the size the
 * reader is given for one value: an array is read a record at a time, an
 * object whole.
 */
export async function jsonStartsWithObject(stream: Readable): Promise<boolean> {
  let first = true
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let i = first && buf.subarray(0, 3).equals(BOM) ? 3 : 0
      first = false
      while (i < buf.length && JSON_WHITESPACE.has(buf[i])) i++
      if (i < buf.length) return buf[i] === 0x7b // '{'
    }
    return false
  } finally {
    stream.destroy()
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Whether a JSON text nests arrays and objects deeper than `maxDepth`, in one
 * pass that stops at the first bracket past it. Brackets inside strings do not
 * count. Read byte by byte: every byte that matters is ASCII, which UTF-8 never
 * uses inside a multi-byte character. Malformed text is not this function's to
 * judge — the reader refuses it — except that a stray closing bracket buys no
 * depth: the count never goes below zero.
 */
export async function jsonNestsDeeperThan(stream: Readable, maxDepth: number): Promise<boolean> {
  let depth = 0
  let inString = false
  let escaped = false
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]
        if (inString) {
          if (escaped) escaped = false
          else if (b === BACKSLASH) escaped = true
          else if (b === QUOTE) inString = false
        } else if (b === QUOTE) inString = true
        else if (b === 0x5b || b === 0x7b) {
          if (++depth > maxDepth) return true
        } else if ((b === 0x5d || b === 0x7d) && depth > 0) depth--
      }
    }
    return false
  } finally {
    stream.destroy()
  }
}

const QUOTE = 0x22
const BACKSLASH = 0x5c

/** Space, tab, line feed and carriage return: the whitespace JSON allows (RFC 8259 §2). */
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * Interpret `jsonPath` and write its Parquet preview to `parquetPath`.
 *
 * @param profilePath - where to write the profile artifact (ADR-063), when the
 *   caller publishes one.
 * @param maxObjectBytes - the largest JSON value the reader takes: a record of
 *   an array, or the whole file when it is one object. The caller refused
 *   files past it already (`version.ts`); here it bounds what the reader
 *   buffers.
 */
export async function interpretJson(
  jsonPath: string,
  parquetPath: string,
  profilePath?: string,
  maxObjectBytes: number = MAX_JSON_OBJECT_SIZE
): Promise<InterpretedTableFile> {
  const { conn, close } = await openDuckdb({
    memoryLimitBytes: INTERPRET_MEMORY_LIMIT_MB * 1_000_000,
    threads: INTERPRET_THREADS,
    spill: 'interpret',
  })
  try {
    const isObject = await jsonStartsWithObject(createReadStream(jsonPath))
    const read = (columns?: string) =>
      readRecords(conn, jsonPath, isObject, maxObjectBytes, columns)
    let found = await read()
    if ('reason' in found) return refused(found.reason)

    // Integers past what a DOUBLE holds, which the reader typed as one: read
    // again with those fields as text, as a CSV's are (ADR-029), or two IDs
    // that differ in the last digit read as one
    const oversized = await oversizeIntegerLeaves(conn, found.leaves)
    if (oversized.length > 0) {
      const columns = await retypedColumns(conn, oversized)
      await conn.run('DROP VIEW recs')
      await conn.run('DROP TABLE src')
      found = await read(columns)
      if ('reason' in found) return refused(found.reason)
    }
    const { records, leaves } = found

    // The records as a flat table, and the reader's tables gone: a view costs
    // nothing to keep, the source would hold the file a second time.
    await conn.run(
      `CREATE TABLE t AS SELECT ${leaves.map((l) => `${l.sql} AS ${sqlIdentifier(l.name)}`).join(', ')} FROM recs`
    )
    await conn.run('DROP VIEW recs')
    await conn.run('DROP TABLE src')

    const columns = await describe(conn)
    const rowCount = await countRows(conn, 't')
    const { described, rowGroupRows, profile } = await writeTable(
      conn,
      columns,
      rowCount,
      parquetPath,
      profilePath
    )
    return {
      rowGroupRows,
      ...(profile && { profile }),
      schema: {
        columns: described,
        rowCount,
        ...(records.geometryTypes && { geometryTypes: records.geometryTypes }),
      },
    }
  } catch (err) {
    const reason = settledReason(err)
    if (reason) return refused(reason)
    throw err
  } finally {
    await close()
  }
}

/**
 * Read the file into `src`, find its records as the view `recs`, and lay out
 * the table's columns — or the reason there is no table.
 *
 * @param columns - the reader's `columns`, where the types it would infer are
 *   to be overridden; inferred over every record otherwise.
 */
async function readRecords(
  conn: DuckDBConnection,
  jsonPath: string,
  isObject: boolean,
  maxObjectBytes: number,
  columns?: string
): Promise<{ records: Records; leaves: Leaf[] } | { reason: NoTableReason }> {
  try {
    await conn.run(
      `CREATE TABLE src AS SELECT * FROM read_json(${sqlLiteral(jsonPath)}, ` +
        `maximum_object_size = ${Math.trunc(maxObjectBytes)}, ` +
        `${columns ? `columns = ${columns}` : READ_OPTIONS})`
    )
  } catch (err) {
    if (!(err instanceof Error)) throw err
    if (TOO_LARGE.test(err.message)) return { reason: 'too-large' }
    if (NOT_RECORDS.test(err.message)) return { reason: 'not-records' }
    throw err
  }

  // An empty array: no record, so no column
  if ((await countRows(conn, 'src')) === 0) return { reason: 'no-columns' }
  const records = isObject
    ? await recordsOfObject(conn, jsonPath)
    : await recordsOfArray(conn, jsonPath)
  if (!records) return { reason: 'not-records' }
  const fields = structFields(records.type)
  if (fields === null) return { reason: 'not-records' }

  const leaves = flatten(fields, records.extra, records.root)
  if (leaves.length === 0) return { reason: 'no-columns' }
  if (leaves.length > MAX_TABLE_COLUMNS) return { reason: 'too-many-columns' }
  return { records, leaves }
}

/** Where a DOUBLE stops holding every digit of an integer (as `OVERSIZE_INTEGER` in csv.ts). */
const OVERSIZE_INTEGER = '1e15'

/** The leaves read as DOUBLE that hold a whole number too large for one, in one pass. */
async function oversizeIntegerLeaves(conn: DuckDBConnection, leaves: Leaf[]): Promise<Leaf[]> {
  const doubles = leaves.filter((l) => l.source && /^(DOUBLE|FLOAT)$/.test(l.source.type))
  if (doubles.length === 0) return []
  const [row] = (
    await conn.runAndReadAll(
      `SELECT ${doubles
        .map(
          (l, i) =>
            `count(*) FILTER (WHERE abs(${l.sql}) >= ${OVERSIZE_INTEGER} AND ${l.sql} = trunc(${l.sql})) AS c${i}`
        )
        .join(', ')} FROM recs`
    )
  ).getRowObjectsJson() as Record<string, unknown>[]
  return doubles.filter((_, i) => Number(row[`c${i}`]) > 0)
}

/**
 * `src`'s columns as the reader's `columns` option, with each of `leaves`
 * retyped as text where it sits — down through structs and lists alike.
 */
async function retypedColumns(conn: DuckDBConnection, leaves: Leaf[]): Promise<string> {
  const columns = await describeTable(conn, 'src')
  const entries = columns.map((c) => {
    let type = c.duckType
    for (const leaf of leaves) {
      const [top, ...rest] = leaf.source!.path
      if (top === c.name) type = retype(type, rest)
    }
    return `${sqlLiteral(c.name)}: ${sqlLiteral(type)}`
  })
  return `{${entries.join(', ')}}`
}

/** `type` with the field at `path` made VARCHAR; a list's element is passed through. */
export function retype(type: string, path: string[]): string {
  if (path.length === 0) return 'VARCHAR'
  if (type.endsWith('[]')) return `${retype(type.slice(0, -2), path)}[]`
  const fields = structFields(type)
  if (!fields) return type
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
  return `STRUCT(${fields
    .map((f) => `${quote(f.name)} ${f.name === path[0] ? retype(f.type, path.slice(1)) : f.type}`)
    .join(', ')})`
}

/** Where the records are: a view `recs` with the record struct in column `r`. */
interface Records {
  /** The DuckDB type of `r`. */
  type: string
  /** The path from a column of `src` down to the record; empty where the row is the record. */
  root: string[]
  /** The kinds of shape a FeatureCollection holds, distinct and sorted; absent elsewhere. */
  geometryTypes?: string[]
  /** Columns of the table beside the record's fields: a feature's `id`, a Point's coordinates. */
  extra: Leaf[]
}

/** A Point's coordinates, as columns of the table. */
const POINT_LEAVES: Leaf[] = [
  { name: 'geometry_lon', sql: 'geometry_lon' },
  { name: 'geometry_lat', sql: 'geometry_lat' },
]

/**
 * A top-level array: the reader made a row of each element, so the row itself
 * is the record.
 *
 * An array of anything but objects comes back as one column named `json` —
 * and so does an array of objects whose one key is `json`, which only the
 * elements themselves tell apart. The row is packed by its column names
 * rather than named by its table's: a key `src` would otherwise be the row.
 *
 * Keys that differ only in case are no table, as they are in a nested object,
 * where the reader refuses them: here it renames the later ones (`ID` beside
 * `id` comes back `ID_1`) and keeps no record of the key it read, so a field
 * re-read under its type (`retypedColumns`) would no longer find its values.
 */
async function recordsOfArray(conn: DuckDBConnection, jsonPath: string): Promise<Records | null> {
  const columns = await describeTable(conn, 'src')
  if (
    columns.length === 1 &&
    columns[0].name === 'json' &&
    !(await firstIsObject(conn, jsonPath))
  ) {
    return null
  }
  if (await keysDifferOnlyInCase(conn, jsonPath, columns)) return null
  const row = columns.map((c) => `${sqlIdentifier(c.name)} := ${sqlIdentifier(c.name)}`)
  await conn.run(`CREATE VIEW recs AS SELECT struct_pack(${row.join(', ')}) AS r FROM src`)
  return { type: await typeOfRecord(conn), root: [], extra: [] }
}

/**
 * Whether the records hold keys that differ only in case. A column named like
 * the reader's renaming (`ID_1` beside `id`) is only a reason to look: a file
 * can carry a key `id_1` of its own, which the keys themselves tell apart.
 * Read only then, as it is a second pass over the file.
 */
async function keysDifferOnlyInCase(
  conn: DuckDBConnection,
  jsonPath: string,
  columns: Column[]
): Promise<boolean> {
  const suspect = columns.some((c) => {
    const base = c.name.match(/^(.*)_\d+$/)?.[1]
    return (
      base !== undefined &&
      columns.some((o) => o.name !== base && o.name.toLowerCase() === base.toLowerCase())
    )
  })
  if (!suspect) return false
  const keys = (
    await conn.runAndReadAll(
      `SELECT DISTINCT unnest(json_keys(json)) FROM read_json_objects(${sqlLiteral(jsonPath)})`
    )
  )
    .getRows()
    .map(([k]) => String(k))
  return new Set(keys.map((k) => k.toLowerCase())).size < keys.length
}

/**
 * A file that starts with `{`: one object — a FeatureCollection's features, or
 * the one array of objects it holds under a key — or objects one per line, which
 * the reader makes a row of each, so the rows are the records. Two arrays under
 * one object would need a choice this cannot make, so they are not records; a
 * scalar or an object beside the one array is left aside, as a title or a
 * `meta` block would be.
 */
async function recordsOfObject(conn: DuckDBConnection, jsonPath: string): Promise<Records | null> {
  if ((await countRows(conn, 'src')) > 1) return recordsOfArray(conn, jsonPath)
  const columns = await describeTable(conn, 'src')
  const features = await featureCollectionRecords(conn, columns)
  if (features !== undefined) return features

  const lists = columns.filter((c) => isListOfStructs(c.duckType))
  if (lists.length !== 1) return null
  await conn.run(`CREATE VIEW recs AS SELECT unnest(${sqlIdentifier(lists[0].name)}) AS r FROM src`)
  return { type: await typeOfRecord(conn), root: [lists[0].name], extra: [] }
}

/**
 * A FeatureCollection's features as records, their `properties` the record and
 * beside it the feature's `id` where any feature has one (RFC 7946 §3.2, a
 * SHOULD that few files follow), and the geometry's type and, for a Point, its
 * coordinates. Null
 * where it is one whose features carry no properties; undefined where the
 * object is no FeatureCollection, and is read as an object of another shape.
 */
async function featureCollectionRecords(
  conn: DuckDBConnection,
  columns: Column[]
): Promise<Records | null | undefined> {
  const features = columns.find((c) => c.name === 'features')
  if (!features || !isListOfStructs(features.duckType) || !columns.some((c) => c.name === 'type')) {
    return undefined
  }
  const [{ kind }] = (
    await conn.runAndReadAll('SELECT "type"::VARCHAR AS kind FROM src')
  ).getRowObjectsJson() as { kind: string | null }[]
  if (kind !== 'FeatureCollection') return undefined

  const feature = structFields(features.duckType.slice(0, -2)) ?? []
  if (!feature.some((f) => f.name === 'properties')) return null
  const geometry = structFields(feature.find((f) => f.name === 'geometry')?.type ?? '') ?? []
  const geometryType = geometry.find((f) => f.name === 'type')
  // As text whatever the reader typed it: a `type` that is not always a
  // string comes back as JSON, quotes and all
  const typeExpr =
    geometryType?.type === 'JSON'
      ? `json_extract_string(f.geometry."type", '$')`
      : `f.geometry."type"`
  const point = geometryType
    ? pointCoordinates(geometry.find((f) => f.name === 'coordinates')?.type, typeExpr)
    : null
  // Read like a field of the record, so a number stays one and JSON is unquoted
  const id = feature.find((f) => f.name === 'id')
  const idSql = id ? leafSql('f."id"', id.type) : null
  await conn.run(
    `CREATE VIEW recs AS SELECT f.properties AS r` +
      (idSql ? `, ${idSql} AS feature_id` : '') +
      (geometryType ? `, ${typeExpr} AS geometry_type` : '') +
      (point ? `, ${point.lon} AS geometry_lon, ${point.lat} AS geometry_lat` : '') +
      ` FROM (SELECT unnest(features) AS f FROM src)`
  )
  const geometryTypes = geometryType ? await distinctGeometryTypes(conn, typeExpr) : undefined
  const pointColumns = !!point && (point.certain || !!geometryTypes?.includes('Point'))
  return {
    type: await typeOfRecord(conn),
    root: ['features', 'properties'],
    geometryTypes,
    extra: [
      ...(idSql && id
        ? [{ name: 'id', sql: 'feature_id', source: { path: ['features', 'id'], type: id.type } }]
        : []),
      ...(pointColumns ? POINT_LEAVES : []),
    ],
  }
}

/**
 * How to read a Point's longitude and latitude out of `coordinates`, from the
 * type the reader gave it: a list of numbers where every feature is a Point;
 * a list of JSON where the shapes are mixed (a Point's element is a number, a
 * line's a list), so each row says whether it is one. Null where no feature
 * can be a Point — every coordinate a list of lists.
 */
function pointCoordinates(
  type: string | undefined,
  typeExpr: string
): { lon: string; lat: string; certain: boolean } | null {
  if (!type) return null
  const at = (i: number) => `f.geometry.coordinates[${i}]::DOUBLE`
  if (/^(DOUBLE|BIGINT|INTEGER|HUGEINT)\[\]$/.test(type)) {
    return { lon: at(1), lat: at(2), certain: true }
  }
  if (type === 'JSON[]') {
    const point = (i: number) => `CASE WHEN ${typeExpr} = 'Point' THEN ${at(i)} END`
    return { lon: point(1), lat: point(2), certain: false }
  }
  return null
}

/**
 * Whether the file's first value is an object, as the reader lays the file out
 * (an array's elements, or values one per line). Anything it cannot answer —
 * no value at all, a layout it refuses — is no object.
 */
async function firstIsObject(conn: DuckDBConnection, jsonPath: string): Promise<boolean> {
  try {
    const rows = (
      await conn.runAndReadAll(
        `SELECT json_type(json) AS kind FROM read_json_objects(${sqlLiteral(jsonPath)}) LIMIT 1`
      )
    ).getRowObjectsJson() as { kind: string }[]
    return rows[0]?.kind === 'OBJECT'
  } catch {
    return false
  }
}

async function countRows(conn: DuckDBConnection, table: string): Promise<number> {
  return Number((await conn.runAndReadAll(`SELECT count(*) FROM ${table}`)).getRows()[0][0])
}

/**
 * Names as the binding gives them (`describe`), types as `DESCRIBE` spells
 * them: the binding prints a `JSON` as the `VARCHAR` it is stored as, and this
 * reader tells the two apart (`flatten`).
 */
async function describeTable(conn: DuckDBConnection, table: string): Promise<Column[]> {
  const named = await describe(conn, table)
  const types = await describedTypes(conn, `SELECT * FROM ${table}`)
  return named.map(({ name }, i) => ({ name, duckType: types[i] }))
}

async function typeOfRecord(conn: DuckDBConnection): Promise<string> {
  return (await describedTypes(conn, 'SELECT r FROM recs'))[0]
}

async function describedTypes(conn: DuckDBConnection, query: string): Promise<string[]> {
  const rows = (await conn.runAndReadAll(`DESCRIBE ${query}`)).getRowObjectsJson() as {
    column_type: string
  }[]
  return rows.map((r) => r.column_type)
}

/**
 * The kinds of shape among the features, read off the list in the one row of
 * `src` rather than by unnesting it: the coordinates are most of the file, and
 * the table is about to walk them once already.
 */
async function distinctGeometryTypes(conn: DuckDBConnection, typeExpr: string): Promise<string[]> {
  const [[types]] = (
    await conn.runAndReadAll(
      `SELECT list_sort(list_distinct(list_transform(features, f -> (${typeExpr})::VARCHAR))) FROM src`
    )
  ).getRowsJson() as [[string[] | null]]
  return types ?? []
}

const isListOfStructs = (type: string) => type.startsWith('STRUCT(') && type.endsWith(')[]')

interface Field {
  name: string
  type: string
}

/**
 * The fields of a DuckDB `STRUCT(...)` type name, or null for any other type.
 * Names the reader quoted are unquoted; a `"` inside one arrives doubled.
 */
export function structFields(type: string): Field[] | null {
  if (!type.startsWith('STRUCT(') || !type.endsWith(')')) return null
  const body = type.slice('STRUCT('.length, -1)
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (const ch of body) {
    if (ch === '"') quoted = !quoted
    if (!quoted) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => {
    const m = part.trim().match(/^("(?:[^"]|"")*"|\S+)\s+([\s\S]+)$/)
    if (!m) return { name: part.trim(), type: '' }
    const name = m[1].startsWith('"') ? m[1].slice(1, -1).replaceAll('""', '"') : m[1]
    return { name, type: m[2] }
  })
}

/** A type a column of the table can hold as it is. */
const SCALAR =
  /^(VARCHAR|BIGINT|HUGEINT|UBIGINT|INTEGER|UINTEGER|SMALLINT|TINYINT|DOUBLE|FLOAT|BOOLEAN|DATE|TIME|TIMESTAMP[A-Z _]*|DECIMAL\(.*\)|UUID)$/

interface Leaf {
  name: string
  /** Over `recs`. */
  sql: string
  /** Where the value sits in `src`, from its column down, and how the reader typed it. */
  source?: { path: string[]; type: string }
}

/**
 * A value of `type` at `expr` as a column holds it: a scalar as it is; anything
 * else — an array, a value the reader could give no one type (`JSON`), a field
 * it saw no value in — as JSON text, with a bare string unquoted.
 */
function leafSql(expr: string, type: string): string {
  if (SCALAR.test(type)) return expr
  if (type === 'JSON') {
    return `CASE WHEN json_type(${expr}) = 'VARCHAR' THEN json_extract_string(${expr}, '$') ELSE ${expr}::VARCHAR END`
  }
  return `CASE WHEN ${expr} IS NULL THEN NULL ELSE to_json(${expr})::VARCHAR END`
}

/** Between the keys of a path, since `.` makes the name no OData identifier (ADR-055). */
const PATH_SEPARATOR = '_'

/**
 * The record's fields as columns: a nested object by its fields, named by the
 * path down to each; a scalar as it is; anything else — an array, a value the
 * reader could give no one type (`JSON`), a field it saw no value in — as JSON
 * text, with a bare string unquoted. Two paths that spell the same name take
 * a suffix, as a header with the same heading twice does.
 *
 * Names are compared without case, as DuckDB compares a table's columns: `id`
 * and `ID` are one name to it.
 *
 * @param extra - columns of the table that are not the record's fields, named
 *   like them and suffixed with them.
 * @param root - the path from a column of `src` down to the record.
 */
export function flatten(fields: Field[], extra: Leaf[] = [], root: string[] = []): Leaf[] {
  const leaves: Leaf[] = []
  const walk = (expr: string, path: string[], type: string) => {
    const nested = structFields(type)
    if (nested && nested.length > 0) {
      for (const f of nested) walk(`${expr}.${sqlIdentifier(f.name)}`, [...path, f.name], f.type)
      return
    }
    leaves.push({
      name: path.join(PATH_SEPARATOR),
      sql: leafSql(expr, type),
      source: { path: [...root, ...path], type },
    })
  }
  for (const f of fields) walk(`r.${sqlIdentifier(f.name)}`, [f.name], f.type)
  leaves.push(...extra)

  // A suffix that spells a later leaf's name moves on, as a header dedup does
  const key = (name: string) => name.toLowerCase()
  const taken = new Set(leaves.map((l) => key(l.name)))
  const seen = new Set<string>()
  return leaves.map((leaf) => {
    let name = leaf.name
    if (seen.has(key(name))) {
      let n = 2
      while (taken.has(key(`${leaf.name}_${n}`))) n++
      name = `${leaf.name}_${n}`
      taken.add(key(name))
    }
    seen.add(key(name))
    return { ...leaf, name }
  })
}
