import { describe, it, expect } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'

describe('DuckDB casting a sign alone (duckdb/duckdb#26532)', () => {
  it('still reads a sign followed by spaces as the integer 0', async () => {
    // The CSV interpretation works around this (`signOnlyCandidates` in
    // `interpret/table/csv.ts`). When this fails, DuckDB has fixed the cast: remove
    // the workaround and this test. The re-read of columns a cast refused stays,
    // since it is right whatever the cast does.
    const conn = await (await DuckDBInstance.create(':memory:')).connect()
    try {
      const [row] = (
        await conn.runAndReadAll(
          "SELECT TRY_CAST('- ' AS BIGINT) AS minus, TRY_CAST('-' AS BIGINT) AS bare"
        )
      ).getRowObjectsJson()
      expect(row).toEqual({ minus: '0', bare: null })
    } finally {
      conn.disconnectSync()
    }
  })
})
