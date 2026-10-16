/**
 * Rows read back from DuckDB as the JSON that API clients receive.
 */
import type { DuckDBResultReader, DuckDBValueConverter, Json } from '@duckdb/node-api'

let safeIntegerJson: Promise<DuckDBValueConverter<Json>> | undefined

/**
 * DuckDB's JSON conversion, except that a 64-bit or wider integer is a number
 * where a double holds it exactly, and a string only past 2^53. CSV integers are
 * BIGINT, as are count(*) and sum(), so the plain conversion made nearly every
 * integer a string. Decided per value, so a column can mix the two; nested
 * values follow the same rule, because the conversion recurses through this.
 *
 * By type id and not by `typeof value === 'bigint'`: TIME and TIME_NS arrive
 * as bigints too, and are times, not integers.
 *
 * Imported when first called, as `openDuckdb` does: this module loads where
 * the native library is missing, and that is reported as a 503 there instead.
 */
async function buildSafeIntegerJson(): Promise<DuckDBValueConverter<Json>> {
  const { DuckDBTypeId, JsonDuckDBValueConverter } = await import('@duckdb/node-api')
  const integers = new Set([
    DuckDBTypeId.BIGINT,
    DuckDBTypeId.UBIGINT,
    DuckDBTypeId.HUGEINT,
    DuckDBTypeId.UHUGEINT,
    DuckDBTypeId.BIGNUM,
  ])
  return (value, type, converter) => {
    if (typeof value === 'bigint' && integers.has(type.typeId)) {
      const n = Number(value)
      return Number.isSafeInteger(n) ? n : value.toString()
    }
    return JsonDuckDBValueConverter(value, type, converter)
  }
}

/**
 * The reader's rows by column name, keyed as `deduplicatedColumnNames()`
 * (`a`, `a:1`), with integers as {@link buildSafeIntegerJson} decides.
 *
 * The OData feed does not come through here: Edm.Int64 past 2^53 is written as
 * the digits (`toEdmValue` in the api package), as that protocol asks.
 */
export async function rowObjectsJson(reader: DuckDBResultReader): Promise<Record<string, Json>[]> {
  // A failed import is not kept, so the next read tries again
  safeIntegerJson ??= buildSafeIntegerJson().catch((err: unknown) => {
    safeIntegerJson = undefined
    throw err
  })
  return reader.convertRowObjects(await safeIntegerJson) as Record<string, Json>[]
}
