import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { writeParquet } from '../../test-helpers/parquet'
import { stat, unlink } from 'node:fs/promises'
import { runSandboxedQuery, type SandboxLimits } from '../../../services/query/duckdb-sandbox'
import { ValidationError, RequestTimeoutError, ServiceUnavailableError } from '@kukan/shared'

const LIMITS: SandboxLimits = {
  maxRows: 10,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  memoryLimitMb: 256,
  threads: 2,
}

const writeFixtureParquet = (n: number) =>
  writeParquet(`SELECT i AS id, 'name' || i AS name FROM range(${n}) t(i)`)

describe('runSandboxedQuery', () => {
  let fixture: string

  beforeAll(async () => {
    fixture = await writeFixtureParquet(100)
  })

  afterAll(async () => {
    await unlink(fixture).catch(() => {})
  })

  it('runs a SELECT against the `data` table', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT count(*) AS c FROM data', LIMITS)
    expect(res.columns).toEqual(['c'])
    expect(res.rows[0].c).toBe('100')
  })

  it('spills somewhere of its own, and takes it away after', async () => {
    // DuckDB names a spill file after the block size, not the instance, so two
    // instances sharing a directory read each other's bytes and both fail. This
    // does not reproduce the collision — it pins that the query gets a
    // directory of its own rather than the working directory's `.tmp`, which is
    // what the default was. The read works after `lock_configuration` because
    // that only stops SET.
    const read = async () => {
      const res = await runSandboxedQuery(
        fixture,
        `SELECT current_setting('temp_directory') AS d`,
        LIMITS
      )
      return res.rows[0].d as string
    }
    const first = await read()
    expect(first).toContain('kukan-query-tmp-')
    expect(await read()).not.toBe(first)
    // Removed with the instance: a container would otherwise keep one per query.
    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns column names and row objects', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT id, name FROM data ORDER BY id', LIMITS)
    expect(res.columns).toEqual(['id', 'name'])
    expect(res.rows[0]).toEqual({ id: '0', name: 'name0' })
  })

  it('deduplicates repeated output column names to match the row keys', async () => {
    const res = await runSandboxedQuery(
      fixture,
      'SELECT id AS a, name AS a FROM data LIMIT 1',
      LIMITS
    )
    expect(res.columns).toEqual(['a', 'a:1'])
    expect(res.rows[0]).toEqual({ a: '0', 'a:1': 'name0' })
  })

  it('truncates results beyond maxRows', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT * FROM data', LIMITS)
    expect(res.truncated).toBe(true)
    expect(res.rowCount).toBe(LIMITS.maxRows)
  })

  it('does not mark a small result as truncated', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT * FROM data LIMIT 3', LIMITS)
    expect(res.truncated).toBe(false)
    expect(res.rowCount).toBe(3)
  })

  it('returns an empty result (columns kept, no rows) for a query matching nothing', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT id, name FROM data WHERE 1 = 0', LIMITS)
    expect(res.columns).toEqual(['id', 'name'])
    expect(res.rows).toEqual([])
    expect(res.rowCount).toBe(0)
    expect(res.truncated).toBe(false)
  })

  it('truncates by serialized byte size (under the row cap)', async () => {
    const tinyBytes = { ...LIMITS, maxRows: 1000, maxBytes: 80 }
    const res = await runSandboxedQuery(fixture, 'SELECT * FROM data', tinyBytes)
    expect(res.truncated).toBe(true)
    expect(res.rowCount).toBeGreaterThan(0)
    expect(res.rowCount).toBeLessThan(100)
  })

  it('interrupts a query that exceeds the time limit', async () => {
    const tinyTimeout = { ...LIMITS, timeoutMs: 50 }
    await expect(
      runSandboxedQuery(
        fixture,
        'SELECT max(a.id + b.id + c.id + d.id) FROM data a, data b, data c, data d',
        tinyTimeout
      )
    ).rejects.toThrow(RequestTimeoutError)
  })

  // --- the configuration a deployment actually runs: the preview over a URL ---

  describe('reading the preview through a URL', () => {
    let server: Server
    let url: string

    beforeAll(async () => {
      // Stands in for the signed URL object storage hands back: ranged GETs,
      // signature in the query string. What matters is that the read goes over
      // httpfs, which is the branch every deployment takes and which no other
      // test here reaches.
      //
      // **HEAD is refused, because that is what really happens.** SigV4 covers
      // the method, so a URL signed for GET answers 403 to the HEAD that DuckDB
      // opens with — measured against MinIO. It recovers by asking for
      // `bytes=0-1` instead, and a server that answered HEAD would hide the day
      // that stops being true.
      const size = (await stat(fixture)).size
      server = createServer((req, res) => {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
        if (req.method === 'HEAD') {
          res.writeHead(403)
          return res.end()
        }
        // One path that is not there, for the failure the redaction is about.
        if (req.url?.includes('/missing')) {
          res.writeHead(404)
          return res.end()
        }
        const start = m ? Number(m[1]) : 0
        const end = m && m[2] ? Number(m[2]) : size - 1
        res.writeHead(m ? 206 : 200, {
          'content-length': String(end - start + 1),
          ...(m && { 'content-range': `bytes ${start}-${end}/${size}` }),
        })
        createReadStream(fixture, { start, end }).pipe(res)
        return
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      const { port } = server.address() as AddressInfo
      url = `http://127.0.0.1:${port}/f.parquet?X-Amz-Signature=deadbeef`
    })

    afterAll(() => {
      server.close()
    })

    it('materializes the table', async () => {
      const res = await runSandboxedQuery(url, 'SELECT count(*) AS c FROM data', LIMITS)
      expect(res.rows[0].c).toBe('100')
    })

    it('cannot read the URL again once the lockdown is on', async () => {
      // On the refusal's own words, not just on the type: `assertReadOnlySql`
      // throws the same `ValidationError`, so a guard that rejected this first
      // would let the test pass without the lockdown having held.
      await expect(
        runSandboxedQuery(url, `SELECT count(*) FROM read_parquet('${url}')`, LIMITS)
      ).rejects.toThrow(/file system operations are disabled/)
    })

    it('empties the settings httpfs seeds from the environment', async () => {
      // Loading `httpfs` copies `AWS_*` into `s3_*` and `HTTP_PROXY` into
      // `http_proxy`, credentials included, and those are plain settings the
      // lockdown does not cover — the same shape as the `aws` finding below, by
      // a different door.
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAPROBE123')
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'super-secret-probe-key')
      vi.stubEnv('AWS_SESSION_TOKEN', 'probe-session-token')
      vi.stubEnv('HTTP_PROXY', 'http://proxyuser:proxypass@proxy.internal:8080')
      try {
        const res = await runSandboxedQuery(
          url,
          `SELECT current_setting('s3_secret_access_key') AS s, current_setting('http_proxy') AS p`,
          LIMITS
        )
        expect(res.rows[0]).toEqual({ s: '', p: '' })
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('keeps the signed URL out of a failed read', async () => {
      // DuckDB names the file in the error, and the MCP tool hands a thrown
      // message straight back to its caller — which would be sixty seconds of
      // read access to that object, to anyone who can make the read fail.
      const missing = url.replace('/f.parquet', '/missing.parquet')
      await expect(runSandboxedQuery(missing, 'SELECT 1', LIMITS)).rejects.toThrow(
        /<the preview URL>/
      )
      await expect(runSandboxedQuery(missing, 'SELECT 1', LIMITS)).rejects.not.toThrow(
        /X-Amz-Signature/
      )
    })

    it('leaves no way to ask for the deployment credentials', async () => {
      // Why this matters, and why the guard does not catch it, is on
      // `materialize`. Here: the extension is not loaded, so the function the
      // lockdown cannot reach is not in the catalog.
      await expect(
        runSandboxedQuery(url, 'SELECT * FROM load_aws_credentials()', LIMITS)
      ).rejects.toThrow(ValidationError)
    })
  })

  // --- sandbox lockdown: queries that pass the SQL guard but must be blocked at runtime ---

  it('blocks reading other files via read_parquet', async () => {
    await expect(
      runSandboxedQuery(fixture, "SELECT * FROM read_parquet('/etc/hostname')", LIMITS)
    ).rejects.toThrow(ValidationError)
  })

  it('blocks reading the filesystem via read_csv', async () => {
    await expect(
      runSandboxedQuery(fixture, "SELECT * FROM read_csv('/etc/hostname')", LIMITS)
    ).rejects.toThrow(ValidationError)
  })

  it('blocks reading URLs (httpfs/glob disabled)', async () => {
    await expect(
      runSandboxedQuery(fixture, "SELECT * FROM read_csv('https://example.com/x.csv')", LIMITS)
    ).rejects.toThrow(ValidationError)
  })

  // These pass the SQL guard (they start with SELECT) but must be blocked at runtime by
  // the sandbox lockdown — they reach the filesystem without the obvious reader names.
  it.each([
    ["FROM '<path>' shorthand", "SELECT * FROM '/etc/hostname'"],
    ['glob() listing', "SELECT * FROM glob('/etc/*')"],
    ['read_json_auto', "SELECT * FROM read_json_auto('/etc/hostname')"],
    ['read_text', "SELECT * FROM read_text('/etc/hostname')"],
    ['read_parquet over https', "SELECT * FROM read_parquet('https://example.com/x.parquet')"],
  ])('blocks filesystem/network escape: %s', async (_label, sql) => {
    await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(ValidationError)
  })

  // --- queries rejected up front by the SQL guard ---

  it('rejects non-SELECT statements (guard)', async () => {
    await expect(runSandboxedQuery(fixture, 'DROP TABLE data', LIMITS)).rejects.toThrow(
      ValidationError
    )
  })

  it('rejects COPY/INSTALL/ATTACH (guard)', async () => {
    for (const sql of ["COPY data TO '/tmp/x.csv'", 'INSTALL httpfs', "ATTACH 'x.db'"]) {
      await expect(runSandboxedQuery(fixture, sql, LIMITS)).rejects.toThrow(ValidationError)
    }
  })

  it('surfaces a bad-SQL error as ValidationError, not a 500', async () => {
    await expect(
      runSandboxedQuery(fixture, 'SELECT nonexistent_col FROM data', LIMITS)
    ).rejects.toThrow(ValidationError)
  })

  it('throws ServiceUnavailableError when DuckDB native library is missing', async () => {
    vi.doMock('@duckdb/node-api', () => {
      throw new Error('Cannot find module')
    })
    const { runSandboxedQuery: run } = await import('../../../services/query/duckdb-sandbox')
    await expect(run(fixture, 'SELECT 1', LIMITS)).rejects.toThrow(ServiceUnavailableError)
    vi.doUnmock('@duckdb/node-api')
  })
})
