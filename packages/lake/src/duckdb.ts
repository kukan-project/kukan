/**
 * Opening a DuckDB instance the way every caller in KUKAN has to.
 *
 * Four places open one — the OData feed's page, the SQL sandbox, the CSV
 * interpretation and the lake — and each had worked out the order for itself:
 * the extension directory a closed network needs, the memory bound, a spill
 * directory of its own, and the close that removes it. Lessons learnt at one
 * did not reach the others. This is the order once; what a caller does after
 * it (which extensions, which filesystems stay open) is still its own, because
 * those are the parts that must differ.
 */
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import { ServiceUnavailableError } from '@kukan/shared'
import { duckdbInstanceOptions } from './config'
import { useOwnTempDirectory } from './spill'

export interface OpenDuckdbOptions {
  /**
   * In bytes. DuckDB's `MB` is 1000-based, so spelling the budget out leaves no
   * room to wonder which was meant.
   */
  memoryLimitBytes?: number
  threads?: number
  /**
   * A spill directory of the instance's own, under this tag — or `null` for an
   * instance that will be forbidden the local filesystem, and so could not
   * spill anyway.
   */
  spill: string | null
}

export interface DuckdbHandle {
  instance: DuckDBInstance
  conn: DuckDBConnection
  /**
   * Removes the spill directory. For an owner that outlives this connection
   * and decides itself when nothing still reads from it (the lake).
   */
  dropTempDir: () => Promise<void>
  /** Disconnect, close the instance, and remove its spill directory. */
  close: () => Promise<void>
}

/**
 * An instance with its bounds and its own spill directory, and one connection
 * to it. The caller loads what it needs and then seals it (`sealDuckdb`).
 *
 * The bounds go in as creation options rather than `SET`s afterwards: they
 * are the instance's from its first allocation, and it is two statements
 * fewer on a path the feed pays once a page.
 */
export async function openDuckdb(opts: OpenDuckdbOptions): Promise<DuckdbHandle> {
  const duckdb = await import('@duckdb/node-api').catch(() => null)
  if (!duckdb) {
    throw new ServiceUnavailableError('DuckDB native library is not available in this environment')
  }
  const instance = await duckdb.DuckDBInstance.create(':memory:', {
    ...duckdbInstanceOptions(),
    ...(opts.memoryLimitBytes !== undefined && {
      memory_limit: `${Math.trunc(opts.memoryLimitBytes)}B`,
    }),
    ...(opts.threads !== undefined && { threads: String(Math.trunc(opts.threads)) }),
  })
  let conn: DuckDBConnection | undefined
  let dropTempDir: () => Promise<void> = async () => {}
  try {
    conn = await instance.connect()
    if (opts.spill !== null) dropTempDir = await useOwnTempDirectory(conn, opts.spill)
  } catch (err) {
    // A failed `useOwnTempDirectory` removed its own directory; the instance
    // is ours to close.
    conn?.disconnectSync()
    instance.closeSync()
    throw err
  }
  const close = async () => {
    try {
      conn.disconnectSync()
      instance.closeSync()
    } finally {
      await dropTempDir()
    }
  }
  return { instance, conn, dropTempDir, close }
}

/**
 * The last of any lockdown: no extension fetched or loaded from here on, and
 * no setting changed by whatever runs next. What the caller closes before this
 * — the whole of external access, or only some filesystems — is its own call.
 */
export async function sealDuckdb(conn: { run(sql: string): Promise<unknown> }): Promise<void> {
  await conn.run('SET autoinstall_known_extensions = false')
  await conn.run('SET autoload_known_extensions = false')
  await conn.run('SET lock_configuration = true')
}
