import { describe, it, expect } from 'vitest'
import { openDuckdb } from '../duckdb'
import { rowObjectsJson } from '../json-rows'

async function rowsOf(sql: string) {
  const { conn, close } = await openDuckdb({ spill: null })
  try {
    return await rowObjectsJson(await conn.runAndReadAll(sql))
  } finally {
    await close()
  }
}

describe('rowObjectsJson', () => {
  it('returns a wide integer as a number, and as a string only where a double cannot hold it', async () => {
    const rows = await rowsOf(
      `SELECT v, [v] AS list, {'v': v} AS struct FROM (VALUES
         (9007199254740991::BIGINT), (9007199254740992::BIGINT), (-9007199254740992::BIGINT)
       ) t(v)`
    )
    expect(rows).toEqual([
      { v: 9007199254740991, list: [9007199254740991], struct: { v: 9007199254740991 } },
      { v: '9007199254740992', list: ['9007199254740992'], struct: { v: '9007199254740992' } },
      { v: '-9007199254740992', list: ['-9007199254740992'], struct: { v: '-9007199254740992' } },
    ])
  })

  it('applies the rule to every wide integer type, and leaves the rest as DuckDB writes them', async () => {
    const [row] = await rowsOf(
      `SELECT count(*) AS n, sum(5::INTEGER) AS total, 18446744073709551615::UBIGINT AS big,
         12::BIGNUM AS bignum, 1.25::DECIMAL(5,2) AS amount, TIME '03:04:05' AS at`
    )
    // TIME arrives as a bigint too: matched by type, it stays a time
    expect(row).toEqual({
      n: 1,
      total: 5,
      big: '18446744073709551615',
      bignum: 12,
      amount: '1.25',
      at: '03:04:05',
    })
  })
})
