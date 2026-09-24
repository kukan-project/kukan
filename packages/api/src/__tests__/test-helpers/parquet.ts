import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'

/**
 * Write a Parquet fixture from one SELECT and return its path.
 *
 * Its own throwaway instance, never the one under test: a sandboxed or
 * locked-down connection cannot write a local file, which is the point of
 * those tests. Kept out of `fixtures.ts` so that only the tests that read
 * Parquet pay for loading DuckDB's native module.
 */
export async function writeParquet(select: string, label = 'fixture'): Promise<string> {
  const path = join(tmpdir(), `kukan-${label}-${randomUUID()}.parquet`)
  const inst = await DuckDBInstance.create(':memory:')
  const conn = await inst.connect()
  await conn.run(`COPY (${select}) TO '${path}' (FORMAT parquet)`)
  conn.disconnectSync()
  inst.closeSync()
  return path
}
