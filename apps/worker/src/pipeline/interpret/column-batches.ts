/**
 * KUKAN Pipeline — per-column aggregates over the interpreted table
 */

import type { DuckDBConnection } from '@duckdb/node-api'
import { STATS_COLUMNS_PER_QUERY } from '@/config'

/**
 * One row of aggregates over `from`, built from each column's `parts` and run
 * {@link STATS_COLUMNS_PER_QUERY} columns at a time (why: that constant).
 *
 * Parts alias by the column's position — `c${i}_…` — never by its name: a CSV
 * header is arbitrary text, and building identifiers out of it is how this
 * produces unparseable SQL. By position the batches merge into one row.
 */
export async function aggregateByColumn(
  conn: DuckDBConnection,
  indices: number[],
  parts: (i: number) => string[],
  from = 't'
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {}
  for (let start = 0; start < indices.length; start += STATS_COLUMNS_PER_QUERY) {
    const batch = indices.slice(start, start + STATS_COLUMNS_PER_QUERY)
    const [got] = (
      await conn.runAndReadAll(`SELECT ${batch.flatMap(parts).join(', ')} FROM ${from}`)
    ).getRowObjectsJson() as Record<string, unknown>[]
    Object.assign(row, got)
  }
  return row
}
