/**
 * The DuckDB session a feed page is read in (ADR-055).
 *
 * **Not the ADR-032 sandbox, and not because this path is trusted.** That one
 * materializes the table first and can then shut external access off entirely,
 * because the user SQL that follows needs nothing outside the process. A feed
 * page is read as it is written, so the object store has to stay reachable for
 * the length of the response — and everything else is closed instead.
 *
 * What the closure is worth, measured against a live session: a local file read
 * is refused, a plain `http://` URL is refused before a socket is opened
 * (the instance metadata service among them), a write is refused, another
 * extension cannot be installed, and none of it can be set back.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceUnavailableError, type Env } from '@kukan/shared'
import {
  duckdbInstanceOptions,
  loadDuckdbExtensions,
  s3SecretBody,
  s3SettingsFromEnv,
  sqlLiteral,
  usesCredentialChain,
} from '@kukan/lake'

export interface SessionOptions {
  /** Where the Parquet is: `s3://bucket/key`, or a path on this filesystem. */
  location: string
  env: Env
  memoryLimitBytes: number
  /**
   * The read's deadline. Needed here and not only by the caller's timer,
   * because `conn.interrupt()` does not reach a blocked HTTP request — see the
   * S3 branch below.
   */
  readTimeoutMs: number
}

/** Whether the location is read over S3 rather than from this filesystem. */
export function isS3Location(location: string): boolean {
  return location.startsWith('s3://')
}

/**
 * Open a connection that can read `location` and as little else as the reading
 * allows. The caller closes both handles.
 */
export async function openSession(opts: SessionOptions) {
  const duckdb = await import('@duckdb/node-api').catch(() => null)
  if (!duckdb) {
    throw new ServiceUnavailableError('DuckDB native library is not available in this environment')
  }
  const instance = await duckdb.DuckDBInstance.create(':memory:', duckdbInstanceOptions())
  const conn = await instance.connect()
  const overS3 = isS3Location(opts.location)
  let tempDir: string | undefined
  const close = async () => {
    conn.disconnectSync()
    instance.closeSync()
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  try {
    // Bytes with a `B` suffix: DuckDB's `MB` is 1000-based, and spelling the
    // budget out leaves no room for the reader to wonder which it meant.
    await conn.run(`SET memory_limit = '${opts.memoryLimitBytes}B'`)
    await conn.run('SET threads = 1')
    // Its own temp directory wherever DuckDB may write at all, because it names
    // spill files after the block size rather than the instance: two in-memory
    // instances that go out of core both write
    // `.tmp/duckdb_temp_storage_S32K-0.tmp` in the process's working directory
    // and read each other's bytes, which fails the query outright. Reproduced
    // at two concurrent pages, and at four. An S3 read has no local filesystem
    // at all (below), so it needs none.
    if (!overS3) {
      tempDir = await mkdtemp(join(tmpdir(), 'kukan-odata-tmp-'))
      await conn.run(`SET temp_directory = ${sqlLiteral(tempDir)}`)
    } else {
      const s3 = s3SettingsFromEnv(opts.env)
      // `aws` only backs the credential chain, so a deployment with static
      // keys would spend ~12 ms a page loading what its secret never calls.
      await loadDuckdbExtensions(conn, usesCredentialChain(s3) ? ['httpfs', 'aws'] : ['httpfs'])
      // Scoped to the bucket the location names: the credentials are offered
      // for it and nothing else. The body is the lake's, so the
      // credential-chain refresh that a production incident put there holds
      // here too.
      const bucket = new URL(opts.location).host
      await conn.run(`CREATE OR REPLACE SECRET feed_s3 (${s3SecretBody(s3, `s3://${bucket}`)})`)
      // **The caller's deadline does not stop a stalled request.** Measured
      // against an endpoint that accepts and never replies, `interrupt()` one
      // second in left the read running for 120 s — httpfs's own 30 s × 4
      // attempts — with the page's slot held throughout; on a two-slot task that
      // is the whole feed. These bound one request, in seconds, and the lock
      // below freezes them.
      await conn.run(`SET http_timeout = ${Math.max(1, Math.floor(opts.readTimeoutMs / 3000))}`)
      await conn.run('SET http_retries = 1')
    }

    // Everything the read does not need, refused — after the extensions are
    // loaded, because loading one is itself a local file read.
    await conn.run('SET autoinstall_known_extensions = false')
    await conn.run('SET autoload_known_extensions = false')
    // A local read keeps the local filesystem, which is where its Parquet is;
    // an S3 read keeps neither it nor plain HTTP, which is what closes the
    // path to the instance metadata service and to anything else on the
    // network. S3FileSystem is separate from HTTPFileSystem, so the feed's own
    // reads go on working — checked both ways.
    const disabled = overS3 ? 'LocalFileSystem,HTTPFileSystem' : 'HTTPFileSystem'
    await conn.run(`SET disabled_filesystems = ${sqlLiteral(disabled)}`)
    await conn.run('SET lock_configuration = true')
    return { conn, close }
  } catch (err) {
    await close()
    throw err
  }
}
