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

import {
  ValidationError,
  RequestAbandonedError,
  RequestTimeoutError,
  ServiceUnavailableError,
} from '@kukan/shared'
import {
  duckdbInstanceOptions,
  loadDuckdbExtensions,
  sqlLiteral,
  useOwnTempDirectory,
} from '@kukan/lake'
import { assertReadOnlySql } from './sql-guard'

export interface SandboxLimits {
  maxRows: number
  maxBytes: number
  timeoutMs: number
  memoryLimitMb: number
  threads: number
  /** The caller's request. Aborting it interrupts the query the same way the
   *  timeout does — an answer nobody will read is not worth the shared slot. */
  signal?: AbortSignal
}

export interface SandboxResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
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

/**
 * What `LOAD httpfs` copies out of the process environment, and hands to anyone
 * who can run a `SELECT` on the instance afterwards.
 */
const ENV_DERIVED_SETTINGS = [
  's3_access_key_id',
  's3_secret_access_key',
  's3_session_token',
  'http_proxy',
  'http_proxy_username',
  'http_proxy_password',
] as const

/**
 * Materialize the preview into `data`, from wherever it is.
 *
 * **Read straight out of object storage where that is where it lives.** The
 * bytes came from there either way; fetching them with the SDK only added a
 * write of up to 100 MB to the container's disk and a read back off it. No user
 * SQL runs in this window — it is checked and executed after the lockdown below
 * — so what is open here is reachable by nothing but this statement.
 *
 * **The URL carries its own authorization, and `aws` is never loaded.** The
 * extension that backs `PROVIDER credential_chain` also registers
 * `load_aws_credentials()`, which is not a filesystem call: it survives
 * `enable_external_access = false` and answers with the task role's key id and
 * session token (measured). A signed URL needs no secret at all, so the
 * function the lockdown cannot reach is never in the instance.
 */
async function materialize(
  conn: { run(sql: string): Promise<unknown> },
  location: string,
  timeoutMs: number
): Promise<void> {
  if (/^https?:\/\//.test(location)) {
    await loadDuckdbExtensions(conn, ['httpfs'])
    // **Loading it imports the environment, and the lockdown does not reach
    // what it imports.** `httpfs` seeds `s3_*` from `AWS_ACCESS_KEY_ID` and
    // friends, and `http_proxy` from `HTTP_PROXY` — credentials and all — and
    // those are plain settings a later `SELECT current_setting(…)` reads back
    // in full (measured, after `enable_external_access = false` and
    // `lock_configuration = true`). Same shape as the `aws` finding above, by a
    // different door. Emptied here, because the URL carries its own
    // authorization and this read goes to the deployment's own object store,
    // never through an egress proxy.
    for (const setting of ENV_DERIVED_SETTINGS) {
      await conn.run(`SET ${setting} = ''`)
    }
    // **`conn.interrupt()` does not reach a blocked HTTP request.** Measured
    // against an endpoint that accepts and never replies, the read outlived the
    // sandbox's deadline eightfold and was ended by httpfs's own retries, with
    // the one concurrency slot held throughout. These bound **one request** —
    // in seconds, not milliseconds — so the statement is bounded by the
    // deadline plus one request's worst case, and `lock_configuration` freezes
    // them a few lines below.
    await conn.run(`SET http_timeout = ${Math.max(1, Math.floor(timeoutMs / 3000))}`)
    await conn.run('SET http_retries = 1')
  }
  try {
    await conn.run(`CREATE TABLE data AS SELECT * FROM read_parquet(${sqlLiteral(location)})`)
  } catch (err) {
    // **The location is a bearer capability, and DuckDB puts it in the error.**
    // A missing object or a transient 503 produces `File '<the whole signed
    // URL>' …`, which the MCP tool hands back to its caller as the tool's text
    // and the error handler writes to the log. Sixty seconds of read access to
    // that object, to anyone who can make the read fail. Taken out here rather
    // than at each sink, so a new sink cannot reintroduce it.
    //
    // No `cause`: the original's `stack` carries the URL too, and pino logs it.
    // Dropping it is the point, not an oversight.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redacting(err, location))
  }
}

/** The failure, with every copy of the URL replaced by what it was for. */
function redacting(err: unknown, location: string): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split(location).join('<the preview URL>')
}

export async function runSandboxedQuery(
  location: string,
  userSql: string,
  limits: SandboxLimits
): Promise<SandboxResult> {
  const duckdb = await import('@duckdb/node-api').catch(() => null)
  if (!duckdb) {
    throw new ServiceUnavailableError('DuckDB native library is not available in this environment')
  }
  // A signal already aborted never fires a listener, so the caller that left
  // while its slot was being waited for has to be caught here.
  if (limits.signal?.aborted) throw new RequestAbandonedError()

  const instance = await duckdb.DuckDBInstance.create(':memory:', duckdbInstanceOptions())
  const conn = await instance.connect()
  let dropTempDir: (() => Promise<void>) | undefined
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  let abandoned = false
  const timeoutMessage = `Query exceeded the time limit of ${limits.timeoutMs} ms`
  const onAbort = () => {
    abandoned = true
    conn.interrupt()
  }
  limits.signal?.addEventListener('abort', onAbort, { once: true })

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
      // Before anything can spill: materializing the table is what goes out of
      // core here, and a spill file shared with another instance fails the
      // query outright (see `useOwnTempDirectory`).
      dropTempDir = await useOwnTempDirectory(conn, 'query')
      // Materialize the preview while external access is still permitted, then lock down
      // before any user SQL runs.
      await materialize(conn, location, limits.timeoutMs)
      await conn.run('SET enable_external_access = false')
      await conn.run('SET autoinstall_known_extensions = false')
      await conn.run('SET autoload_known_extensions = false')
      await conn.run('SET lock_configuration = true')
    } catch (err) {
      // Setup faults → 500; a timeout during setup → 408.
      if (abandoned) throw new RequestAbandonedError()
      if (timedOut) throw new RequestTimeoutError(timeoutMessage)
      throw err
    }

    assertReadOnlySql(userSql)

    let reader
    try {
      // Read one past the cap so truncation is detectable without scanning everything.
      reader = await conn.runAndReadUntil(userSql, limits.maxRows + 1)
    } catch (err) {
      // An interrupted statement fails with a DuckDB error; which of the two
      // interrupts it was decides whether this is a timeout or nobody's query.
      if (abandoned) throw new RequestAbandonedError()
      if (timedOut) throw new RequestTimeoutError(timeoutMessage)
      throw new ValidationError(`Query failed: ${firstLine(err)}`)
    }
    clearTimeout(timer)
    timer = undefined

    // Deduplicated (`a`, `a:1`) to match getRowObjectsJson's row keys — the
    // raw names would repeat duplicates and point consumers at missing keys.
    const columns = reader.deduplicatedColumnNames()
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
    limits.signal?.removeEventListener('abort', onAbort)
    conn.disconnectSync()
    instance.closeSync()
    await dropTempDir?.()
  }
}
