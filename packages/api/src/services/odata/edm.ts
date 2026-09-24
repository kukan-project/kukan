/**
 * EDM (OData Entity Data Model) mapping for the read-only OData feed (ADR-055).
 *
 * One table, one entity set: a resource's preview Parquet (ADR-014 / ADR-029)
 * shown as `Rows`, typed from the column schema ADR-032 Part A persisted. What
 * lives here is the translation — identifiers, types, values — so the router
 * and the service stay about HTTP and reading.
 *
 * **Step 1 (ADR-055 §段階) takes column names as they are.** A name that is not
 * an EDM identifier is not renamed here; the resource is refused instead
 * (`unsupportedColumns`), because the normalization rules — conversion,
 * collision, where the original heading goes — are the ADR's first open item
 * and belong in one decision rather than in a guess made per column.
 */

import { canIdentifyRows, frozenKeyFault, sameKeyColumns } from '@kukan/shared'
import type {
  OdataKey,
  OdataKeyFallback,
  OdataRefusal,
  OdataRefusalReason,
  ResourceColumn,
  ResourceColumnType,
  ResourceSchema,
} from '@kukan/shared'
import { ODATA_ENTITY_SET } from '@kukan/shared'

/** Namespace of the generated CSDL schema. */
export const EDM_NAMESPACE = 'KUKAN'
/** Entity type holding one row of the table. */
export const ENTITY_TYPE = 'Row'
/** Entity container name (required by CSDL; never appears in a feed URL). */
export const ENTITY_CONTAINER = 'Container'

/**
 * CSDL SimpleIdentifier: a letter or `_`, then up to 127 more letters, digits,
 * `_`, or combining marks (OData CSDL 4.01 §17.2). Japanese headings pass —
 * `人口` is a letter run — which is why the refusal below is about brackets,
 * spaces and periods rather than about the script.
 */
const SIMPLE_IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]{0,127}$/u

export function isEdmIdentifier(name: string): boolean {
  return SIMPLE_IDENTIFIER.test(name)
}

/**
 * DuckDB-inferred column type → EDM primitive type.
 *
 * `timestamp` is the lossy one: OData V4 has no naive date-time, so a column
 * the file wrote without a zone is declared `Edm.DateTimeOffset` and serialized
 * as UTC (see {@link toEdmValue}). Declaring it `Edm.String` instead would cost
 * every client its date axis, which is the point of connecting a BI tool.
 */
const EDM_TYPE: Record<ResourceColumnType, string> = {
  integer: 'Edm.Int64',
  float: 'Edm.Double',
  boolean: 'Edm.Boolean',
  string: 'Edm.String',
  date: 'Edm.Date',
  timestamp: 'Edm.DateTimeOffset',
}

/** The model a resource's feed is served from — names resolved, types mapped. */
export interface EdmModel {
  /** Properties `<Key>` names: the table's own key, or the synthetic one. */
  keyNames: string[]
  /**
   * The synthetic key's property name, or null when the table's own key is
   * used — which is also what says whether rows carry an extra column.
   */
  syntheticKey: string | null
  /** Why the key had to be invented; null where it was not (reported to the page). */
  keyFallback: OdataKeyFallback | null
  columns: ResourceColumn[]
  rowCount: number
}

/**
 * Why a schema cannot be served as OData, or null when it can.
 *
 * Both refusals are Step 1's scope rather than permanent limits: normalization
 * (ADR-055 open item 1) answers the first, and the second is a duplicate the
 * interpreter should not have written in the first place.
 */
export type EdmRefusal = Extract<OdataRefusalReason, 'unsupported-columns' | 'duplicate-columns'>

/**
 * Why a schema cannot be served, and which headings are the reason.
 *
 * The headings come back because the person reading them can usually fix the
 * table: a unit moved out of `人口（人）` is a table this feed can serve. A
 * refusal that names nothing leaves them comparing two resources and guessing.
 * All of them, not a sample — the response that carries this carries the whole
 * column list anyway, and whoever shows it decides how many to show.
 */
export type EdmRefusalDetail = OdataRefusal<EdmRefusal>

export function edmRefusal(schema: ResourceSchema): EdmRefusalDetail | null {
  const names = schema.columns.map((c) => c.name)
  const unsupported = names.filter((name) => !isEdmIdentifier(name))
  if (unsupported.length > 0) return { reason: 'unsupported-columns', columns: unsupported }
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const name of names) (seen.has(name) ? duplicated : seen).add(name)
  if (duplicated.size > 0) return { reason: 'duplicate-columns', columns: [...duplicated] }
  return null
}

/**
 * Name for the synthetic key, kept clear of the table's own columns.
 *
 * An OData EntityType must have a key, so where the table's own cannot be used
 * (see {@link buildModel}) the row's position in the Parquet becomes one. A table that already has a `RowId` column gets `RowId_`, and so on:
 * the model is built once per request, so both the `$metadata` and the rows
 * agree on whichever name this returns.
 */
export function pickKeyName(columns: ResourceColumn[]): string {
  const taken = new Set(columns.map((c) => c.name))
  let name = 'RowId'
  while (taken.has(name)) name += '_'
  return name
}

/**
 * Whether an integer column's values survive the reader's own JSON parser.
 *
 * The digits leave here intact ({@link toEdmValue}), but a client that parses
 * a JSON number into a double has only 2^53 to work with — 9007199254740992
 * and …93 become one value in its hands. Anywhere else that is a rounded
 * figure; in a key it is two rows merged into one, silently. So the key waits
 * for a range the reader cannot lose, and the bound is answerable without
 * touching the data: the interpretation froze each integer column's min and
 * max as decimal strings for exactly this reason (ADR-046). **No stats, no
 * key** — an unknown range is not a safe one.
 */
function digitsSurviveJson(column: ResourceColumn): boolean {
  if (column.type !== 'integer') return true
  if (!column.stats) return false
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  try {
    return BigInt(String(column.stats.min)) >= -limit && BigInt(String(column.stats.max)) <= limit
  } catch {
    // A bound that is not a plain integer literal (a float column's number
    // written under an integer type, say) answers nothing about the range.
    return false
  }
}

/**
 * The table's own key, when the publisher designated one this feed may use.
 *
 * An OData key is a promise that the values identify the row, and CSDL adds
 * that no part of it is nullable or an `Edm.Double`. **The promise is only
 * made where something has already checked it against the rows being served**
 * — a key that repeats has a BI tool folding rows together with nothing in the
 * response to say so. Two checks answer, both free here: {@link frozenKeyFault}
 * for a single column, and for any key, composite included, the verdict the
 * layer-2 ingest reached against the same interpreted Parquet (spec §6.6) — a
 * version whose key repeats never enters layer 2, so the key recorded beside a
 * snapshot *is* the answer. A composite key therefore waits for that ingest.
 *
 * The verdicts are the key check's own ({@link KeyCheckFault}), so a key KUKAN
 * refuses and a key this declines say the same word.
 */
function designatedKey(
  schema: ResourceSchema,
  primaryKey: string[] | null,
  verifiedKey: string[] | null
): OdataKeyFallback | null {
  if (!primaryKey?.length) return 'not-designated'
  const fault = frozenKeyFault(schema, primaryKey)
  if (fault === 'key-missing') return fault

  const named = primaryKey.map((name) => schema.columns.find((c) => c.name === name)!)
  // The catalogue's rule is OData's here, so asking the shared predicate rather
  // than listing the types again means a settled `decimal` (ii-c) arrives in
  // both at once instead of in whichever was remembered.
  if (!named.every((c) => canIdentifyRows(c.type))) return 'key-float'
  if (!named.every(digitsSurviveJson)) return 'unsafe-integers'
  if (fault !== undefined) return fault

  // The counts cannot answer — a combination, or a schema from before they
  // were frozen. A missing value makes a key that cannot match, which is why
  // the lake refuses one too and CSDL will not declare it; the rest is the
  // ingest's verdict, on this version.
  if (named.some((c) => c.nullCount > 0)) return 'key-null'
  return sameKeyColumns(primaryKey, verifiedKey) ? null : 'unverified'
}

export function buildModel(
  schema: ResourceSchema,
  primaryKey: string[] | null = null,
  verifiedKey: string[] | null = null
): EdmModel {
  const keyFallback = designatedKey(schema, primaryKey, verifiedKey)
  const syntheticKey = keyFallback ? pickKeyName(schema.columns) : null
  return {
    keyNames: syntheticKey ? [syntheticKey] : primaryKey!,
    syntheticKey,
    keyFallback,
    columns: schema.columns,
    rowCount: schema.rowCount,
  }
}

/** What the resource page reports about the feed's key (ADR-055 §1'). */
export function odataKeyOf(model: EdmModel): OdataKey {
  return {
    names: model.keyNames,
    synthetic: model.syntheticKey !== null,
    fallback: model.keyFallback,
  }
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** CSDL (`$metadata`) document for one resource's table. */
export function buildMetadataXml(model: EdmModel): string {
  const properties = model.columns.map((col) => {
    const type = EDM_TYPE[col.type]
    // A key property may not be nullable (CSDL 4.01 §6.5), and one chosen here
    // holds no missing value in this version: `designatedKey` refuses a column
    // whose `nullCount` is not zero.
    const nullable = model.keyNames.includes(col.name) ? false : col.nullable
    return `        <Property Name="${escapeXmlAttr(col.name)}" Type="${type}" Nullable="${nullable}"/>`
  })
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">',
    '  <edmx:DataServices>',
    `    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="${EDM_NAMESPACE}">`,
    `      <EntityType Name="${ENTITY_TYPE}">`,
    `        <Key>${model.keyNames.map((n) => `<PropertyRef Name="${escapeXmlAttr(n)}"/>`).join('')}</Key>`,
    ...(model.syntheticKey
      ? [
          `        <Property Name="${escapeXmlAttr(model.syntheticKey)}" Type="Edm.Int64" Nullable="false"/>`,
        ]
      : []),
    ...properties,
    '      </EntityType>',
    `      <EntityContainer Name="${ENTITY_CONTAINER}">`,
    `        <EntitySet Name="${ODATA_ENTITY_SET}" EntityType="${EDM_NAMESPACE}.${ENTITY_TYPE}"/>`,
    '      </EntityContainer>',
    '    </Schema>',
    '  </edmx:DataServices>',
    '</edmx:Edmx>',
    '',
  ].join('\n')
}

/**
 * `JSON.rawJSON` — ES2024, and what lets `JSON.stringify` write digits rather
 * than the double they would round to. TypeScript's libs do not declare it yet.
 */
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON

/**
 * A numeric cell as OData JSON writes it.
 *
 * BIGINT arrives as a bigint and DECIMAL as a value object; neither survives
 * `JSON.stringify`, and both are a number to a client reading `Edm.Int64` /
 * `Edm.Double`. A bigint converts directly; a value object has to print itself
 * first — 35 ns a cell against 5 when the common case goes direct.
 */
function toEdmNumber(value: NonNullable<unknown>): number | string {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : Number(value.toString())
  if (Number.isFinite(n)) return n
  // `nan`, `inf` and `-inf` in a CSV are read as a DOUBLE column, so they
  // arrive here as numbers JSON.stringify writes as `null` — a value the file
  // had, reaching the client as a gap, under a property the metadata declared
  // non-nullable. OData JSON 4.01 spells them as these strings.
  return Number.isNaN(n) ? 'NaN' : n > 0 ? 'INF' : '-INF'
}

/**
 * One value, as the declared EDM type is written in OData JSON.
 *
 * The values arrive as DuckDB's own: a bigint for BIGINT, value objects for
 * DECIMAL, DATE and TIMESTAMP. None of those survives `JSON.stringify` as the
 * declared EDM type — a bigint throws, a value object serializes as `{}` — so
 * each is converted here, driven by the type the schema declared rather than by
 * what the value happens to be.
 */
export function toEdmValue(value: unknown, type: ResourceColumnType): unknown {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'integer':
      if (typeof value === 'bigint') {
        // An Int64 past 2^53 has no exact JS number: `Number(9007199254740993n)`
        // is 9007199254740992, and the feed would be answering with a value the
        // file does not hold. Its digits go out as they are instead — JSON puts
        // no limit on how many a number may have, so a client that parses into
        // a 64-bit integer gets the value back and one that parses into a
        // double is where it was. Emitting them as strings is the other way,
        // and it needs `IEEE754Compatible` negotiated (ADR-055 open item 3).
        const n = Number(value)
        return Number.isSafeInteger(n) ? n : rawJSON(value.toString())
      }
      return toEdmNumber(value)
    case 'float':
      return toEdmNumber(value)
    case 'boolean':
      return typeof value === 'boolean' ? value : Boolean(value)
    case 'timestamp': {
      // No zone in the file, none in the Parquet: this asserts UTC rather than
      // discovering it (ADR-055 open item 3).
      //
      // A column the reader typed `TIMESTAMP WITH TIME ZONE` does carry one,
      // and DuckDB prints a whole-hour offset as `+09` — hours only. That is
      // not a DateTimeOffset, and appending `Z` to it made `…+09Z`, which a BI
      // client rejects for the whole column. So the offset is completed to
      // `±HH:MM` rather than treated as absent.
      const iso = String(value).replace(' ', 'T')
      const offset = /([+-])(\d{2}):?(\d{2})?$/.exec(iso)
      if (offset && iso.lastIndexOf('T') < offset.index) {
        return `${iso.slice(0, offset.index)}${offset[1]}${offset[2]}:${offset[3] ?? '00'}`
      }
      return /[Zz]$/.test(iso) ? iso : `${iso}Z`
    }
    default:
      // `date` and `string`, both of which a value object spells out correctly
      return typeof value === 'string' ? value : String(value)
  }
}
