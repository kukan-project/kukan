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

import type { Env } from '@kukan/shared'
import {
  type DuckdbHandle,
  loadDuckdbExtensions,
  openDuckdb,
  s3SecretBody,
  s3SettingsFromEnv,
  sealDuckdb,
  sqlLiteral,
  usesCredentialChain,
} from '@kukan/lake'

/** Whether the location is read over S3 rather than from this filesystem. */
export function isS3Location(location: string): boolean {
  return location.startsWith('s3://')
}

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

/**
 * An instance that can read `location` and as little else as the reading
 * allows, and the connection it was prepared on. Everything it is set to holds
 * for every connection opened on it later, which is what lets the feed keep it
 * between pages (`feed-pool.ts`).
 */
export async function prepareFeedInstance(opts: SessionOptions): Promise<DuckdbHandle> {
  const overS3 = isS3Location(opts.location)
  const handle = await openDuckdb({
    memoryLimitBytes: opts.memoryLimitBytes,
    threads: 1,
    spill: overS3 ? null : 'odata',
  })
  const { conn } = handle
  try {
    if (overS3) {
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
      // is the whole feed. These bound one request, in seconds, and the seal
      // below freezes them.
      //
      // GLOBAL, because a plain SET of an httpfs option binds this connection
      // only: the next one on the instance is back at 30 s × 4, checked.
      await conn.run(
        `SET GLOBAL http_timeout = ${Math.max(1, Math.floor(opts.readTimeoutMs / 3000))}`
      )
      await conn.run('SET GLOBAL http_retries = 1')
    }

    // An instance kept between pages must not keep what they read: remote
    // blocks stay in its buffer pool until pressure inside it evicts them,
    // which is the lake's measured 206 MB (`@kukan/lake` connection.ts).
    // Footers likewise, and those grow with every distinct file read — 200 MB
    // of RSS over 60 wide ones. Off by default today; said here so that a
    // DuckDB upgrade changing the default cannot turn it on. GLOBAL for the
    // reason the http bounds above are: a plain SET of the metadata cache
    // reaches this connection only (checked).
    await conn.run('SET GLOBAL enable_external_file_cache = false')
    await conn.run('SET GLOBAL parquet_metadata_cache = false')

    // A local read keeps the local filesystem, which is where its Parquet is;
    // an S3 read keeps neither it nor plain HTTP, which is what closes the
    // path to the instance metadata service and to anything else on the
    // network. S3FileSystem is separate from HTTPFileSystem, so the feed's own
    // reads go on working — checked both ways. After the extensions, because
    // loading one is itself a local file read.
    const disabled = overS3 ? 'LocalFileSystem,HTTPFileSystem' : 'HTTPFileSystem'
    await conn.run(`SET disabled_filesystems = ${sqlLiteral(disabled)}`)
    await sealDuckdb(conn)
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}
