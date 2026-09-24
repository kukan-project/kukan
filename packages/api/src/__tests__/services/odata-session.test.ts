import { describe, it, expect } from 'vitest'
import type { Env } from '@kukan/shared'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isS3Location, openSession } from '../../services/odata/session'

const env = {
  S3_BUCKET: 'kukan-test',
  S3_REGION: 'ap-northeast-1',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
} as unknown as Env

/** Run `sql` in a session opened for `location`, and report how it ended. */
async function attempt(location: string, sql: string): Promise<string> {
  const { conn, close } = await openSession({
    location,
    env,
    memoryLimitBytes: 64_000_000,
    readTimeoutMs: 15_000,
  })
  try {
    await conn.runAndReadAll(sql)
    return 'allowed'
  } catch (err) {
    return String(err).split('\n')[0]
  } finally {
    await close()
  }
}

const S3 = 's3://kukan-test/previews/x.parquet'

describe('the extension directory', () => {
  it('is handed to DuckDB, which does not read the variable itself', async () => {
    // Without this the load looks in the default location, finds nothing, and
    // reaches for extensions.duckdb.org — which is what a closed-network
    // deployment cannot do. The image installs them at build time and points
    // this variable at them.
    const previous = process.env.DUCKDB_EXTENSION_DIRECTORY
    const dir = await mkdtemp(join(tmpdir(), 'kukan-ext-'))
    process.env.DUCKDB_EXTENSION_DIRECTORY = dir
    try {
      const { conn, close } = await openSession({
        location: '/tmp/none.parquet',
        env,
        memoryLimitBytes: 64_000_000,
        readTimeoutMs: 15_000,
      })
      try {
        const reader = await conn.runAndReadAll(
          `SELECT current_setting('extension_directory') AS dir`
        )
        expect((reader.getRowObjectsJson()[0] as { dir: string }).dir).toBe(dir)
      } finally {
        await close()
      }
    } finally {
      // Assigning `undefined` to a process.env entry stores the *string*
      // "undefined", which the next session would hand DuckDB as a relative
      // path — an `undefined/` tree of downloaded extensions under the working
      // directory, and a closed network reaching for the internet again.
      if (previous === undefined) delete process.env.DUCKDB_EXTENSION_DIRECTORY
      else process.env.DUCKDB_EXTENSION_DIRECTORY = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isS3Location', () => {
  it('tells the two kinds of location apart', () => {
    expect(isS3Location(S3)).toBe(true)
    expect(isS3Location('/tmp/x.parquet')).toBe(false)
  })
})

// The session is what stands between an open object store and everything else
// on the network, and a guard nothing exercises is a guard that rots.
describe('a session opened for S3', () => {
  it('refuses to read a local file', async () => {
    expect(await attempt(S3, `SELECT * FROM read_csv('/etc/hostname')`)).toMatch(
      /LocalFileSystem has been disabled/
    )
  })

  it('refuses a plain http URL, without opening a socket', async () => {
    // 169.254.169.254 is the instance metadata service; the refusal is what
    // stops a reachable one being reachable from here.
    expect(
      await attempt(S3, `SELECT * FROM read_csv('http://169.254.169.254/latest/meta-data/')`)
    ).toMatch(/HTTPFileSystem has been disabled/)
  }, 30_000)

  it('refuses to write', async () => {
    expect(await attempt(S3, `COPY (SELECT 1) TO '/tmp/kukan-odata-escape.csv'`)).toMatch(
      /has been disabled/
    )
  })

  it('refuses to be set back', async () => {
    expect(await attempt(S3, `SET disabled_filesystems = ''`)).toMatch(
      /Cannot change configuration/
    )
  })

  it('refuses another extension', async () => {
    expect(await attempt(S3, `INSTALL spatial`)).toMatch(/has been disabled|Cannot change/)
  })
})

describe('a session opened for a local file', () => {
  it('keeps the filesystem its Parquet is on', async () => {
    expect(await attempt('/tmp/none.parquet', `SELECT 1 AS ok`)).toBe('allowed')
  })

  it('still refuses the network — httpfs is never loaded, and cannot be', async () => {
    expect(
      await attempt('/tmp/none.parquet', `SELECT * FROM read_csv('http://127.0.0.1:1/x')`)
    ).toMatch(/requires the extension httpfs/)
  })
})
