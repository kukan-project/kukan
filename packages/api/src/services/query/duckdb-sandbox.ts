/**
 * Sandboxed DuckDB execution for server-side resource queries (ADR-032 Part B).
 *
 * Each call uses a throwaway in-memory DuckDB instance. The preview Parquet is
 * materialized into a table named `data` while external access is still on, then the
 * instance is locked down so the user SQL can touch nothing but that in-memory table:
 *   - enable_external_access = false  (no files, URLs, httpfs, COPY)
 *   - autoinstall/autoload_known_extensions = false  (no extension fetch/load)
 *   - memory_limit / threads  (resource bounds)
 *   - lock_configuration = true  (user SQL cannot SET its way back out)
 * Results are capped by row count and serialized byte size; a wall-clock timeout
 * interrupts the connection (DuckDB has no statement_timeout).
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { ValidationError, RequestTimeoutError } from '@kukan/shared'
import { assertReadOnlySql } from './sql-guard'

export interface SandboxLimits {
  maxRows: number
  maxBytes: number
  timeoutMs: number
  memoryLimitMb: number
  threads: number
}

export interface SandboxResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

/** Single-quote a string literal for safe interpolation into SQL. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Largest number of leading rows whose JSON serialization stays within maxBytes. */
function rowsWithinByteLimit(rows: unknown[], maxBytes: number): number {
  // Fast path for the common case: the whole set fits, so skip per-row accounting.
  if (Buffer.byteLength(JSON.stringify(rows)) <= maxBytes) return rows.length
  let total = 2 // the enclosing "[]"
  for (let i = 0; i < rows.length; i++) {
    total += Buffer.byteLength(JSON.stringify(rows[i])) + (i > 0 ? 1 : 0) // + comma
    if (total > maxBytes) return i
  }
  return rows.length
}

/** First line of an error message, for surfacing a DuckDB failure to the caller. */
function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0]
}

export async function runSandboxedQuery(
  parquetPath: string,
  userSql: string,
  limits: SandboxLimits
): Promise<SandboxResult> {
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeoutMessage = `Query exceeded the time limit of ${limits.timeoutMs} ms`

  try {
    // The timeout also covers materialization: a huge or pathological Parquet must not
    // hold the connection (and the global semaphore) indefinitely.
    timer = setTimeout(() => {
      timedOut = true
      conn.interrupt()
    }, limits.timeoutMs)

    try {
      await conn.run(`SET memory_limit = '${limits.memoryLimitMb}MB'`)
      await conn.run(`SET threads = ${limits.threads}`)
      // Materialize the preview while external access is still permitted, then lock down
      // before any user SQL runs.
      await conn.run(`CREATE TABLE data AS SELECT * FROM read_parquet(${sqlLiteral(parquetPath)})`)
      await conn.run('SET enable_external_access = false')
      await conn.run('SET autoinstall_known_extensions = false')
      await conn.run('SET autoload_known_extensions = false')
      await conn.run('SET lock_configuration = true')
    } catch (err) {
      // Setup faults → 500; a timeout during setup → 408.
      if (timedOut) throw new RequestTimeoutError(timeoutMessage)
      throw err
    }

    assertReadOnlySql(userSql)

    let reader
    try {
      // Read one past the cap so truncation is detectable without scanning everything.
      reader = await conn.runAndReadUntil(userSql, limits.maxRows + 1)
    } catch (err) {
      if (timedOut) throw new RequestTimeoutError(timeoutMessage)
      throw new ValidationError(`Query failed: ${firstLine(err)}`)
    }
    clearTimeout(timer)
    timer = undefined

    const columns = reader.columnNames()
    const all = reader.getRowObjectsJson() as Record<string, unknown>[]
    let truncated = all.length > limits.maxRows
    let rows = truncated ? all.slice(0, limits.maxRows) : all

    const fit = rowsWithinByteLimit(rows, limits.maxBytes)
    if (fit < rows.length) {
      truncated = true
      rows = rows.slice(0, fit)
    }

    return { columns, rows, rowCount: rows.length, truncated }
  } finally {
    if (timer) clearTimeout(timer)
    conn.disconnectSync()
    instance.closeSync()
  }
}
