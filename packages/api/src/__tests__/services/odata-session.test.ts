import { describe, it, expect, vi } from 'vitest'
import type { Env } from '@kukan/shared'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isS3Location, prepareFeedInstance } from '../../services/odata/session'

const env = {
  S3_BUCKET: 'kukan-test',
  S3_REGION: 'ap-northeast-1',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
} as unknown as Env

/**
 * A connection on an instance prepared for `location`: the one it was prepared
 * on, or — what every page after the first gets from the pool — a later one.
 */
async function connect(location: string, later: boolean) {
  const handle = await prepareFeedInstance({
    location,
    env,
    memoryLimitBytes: 64_000_000,
    readTimeoutMs: 15_000,
  })
  if (!later) return handle
  const conn = await handle.instance.connect()
  return {
    conn,
    close: async () => {
      conn.disconnectSync()
      await handle.close()
    },
  }
}

/** The rows of `sql` on a connection opened for `location`. */
async function rows(location: string, sql: string, later = false) {
  const { conn, close } = await connect(location, later)
  try {
    return (await conn.runAndReadAll(sql)).getRowObjectsJson()
  } finally {
    await close()
  }
}

/** Run `sql` on a connection opened for `location`, and report how it ended. */
async function attempt(location: string, sql: string, later = false): Promise<string> {
  try {
    await rows(location, sql, later)
    return 'allowed'
  } catch (err) {
    return String(err).split('\n')[0]
  }
}

const S3 = 's3://kukan-test/previews/x.parquet'

describe('the extension directory', () => {
  it('is handed to DuckDB, which does not read the variable itself', async () => {
    // Without this the load looks in the default location, finds nothing, and
    // reaches for extensions.duckdb.org — which is what a closed-network
    // deployment cannot do. The image installs them at build time and points
    // this variable at them.
    const dir = await mkdtemp(join(tmpdir(), 'kukan-ext-'))
    vi.stubEnv('DUCKDB_EXTENSION_DIRECTORY', dir)
    try {
      expect(
        await rows('/tmp/none.parquet', `SELECT current_setting('extension_directory') AS dir`)
      ).toEqual([{ dir }])
    } finally {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// The session is what stands between an open object store and everything else
// on the network, and a guard nothing exercises is a guard that rots. Asked on
// a later connection as well: the pool serves every page after the first on
// one, and a setting bound to the connection it was made on is gone there.
describe.each([
  ['on the connection it was prepared on', false],
  ['on a later connection', true],
])('an instance prepared for S3, %s', (_, later) => {
  it('refuses to read a local file', async () => {
    expect(await attempt(S3, `SELECT * FROM read_csv('/etc/hostname')`, later)).toMatch(
      /LocalFileSystem has been disabled/
    )
  })

  it('refuses a plain http URL, without opening a socket', async () => {
    // 169.254.169.254 is the instance metadata service; the refusal is what
    // stops a reachable one being reachable from here.
    expect(
      await attempt(S3, `SELECT * FROM read_csv('http://169.254.169.254/latest/meta-data/')`, later)
    ).toMatch(/HTTPFileSystem has been disabled/)
  }, 30_000)

  it('refuses to write', async () => {
    expect(await attempt(S3, `COPY (SELECT 1) TO '/tmp/kukan-odata-escape.csv'`, later)).toMatch(
      /has been disabled/
    )
  })

  it('refuses to be set back', async () => {
    expect(await attempt(S3, `SET disabled_filesystems = ''`, later)).toMatch(
      /Cannot change configuration/
    )
  })

  it('refuses another extension', async () => {
    expect(await attempt(S3, `INSTALL spatial`, later)).toMatch(/has been disabled|Cannot change/)
  })

  it('bounds a stalled request', async () => {
    // httpfs's own 30 s × 4 is the stall the bound exists to stop.
    expect(
      await rows(
        S3,
        `SELECT current_setting('http_timeout') AS t, current_setting('http_retries') AS r`,
        later
      )
    ).toEqual([{ t: '5', r: '1' }])
  })

  it('keeps nothing it read', async () => {
    expect(
      await rows(
        S3,
        `SELECT current_setting('enable_external_file_cache') AS files, ` +
          `current_setting('parquet_metadata_cache') AS footers`,
        later
      )
    ).toEqual([{ files: false, footers: false }])
  })

  it('offers its credentials to the one bucket', async () => {
    expect(await rows(S3, `SELECT name, scope FROM duckdb_secrets()`, later)).toEqual([
      { name: 'feed_s3', scope: ['s3://kukan-test'] },
    ])
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

describe('isS3Location', () => {
  it('tells an object in the bucket from a path on this filesystem', () => {
    expect(isS3Location(S3)).toBe(true)
    expect(isS3Location('/tmp/x.parquet')).toBe(false)
    expect(isS3Location('https://example.com/x.parquet')).toBe(false)
  })
})
