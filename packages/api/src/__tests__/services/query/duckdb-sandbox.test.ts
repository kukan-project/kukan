import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runSandboxedQuery, type SandboxLimits } from '../../../services/query/duckdb-sandbox'
import { ValidationError, RequestTimeoutError, ServiceUnavailableError } from '@kukan/shared'

const LIMITS: SandboxLimits = {
  maxRows: 10,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  memoryLimitMb: 256,
  threads: 2,
}

/** Write a small Parquet fixture with `n` rows using a separate (un-sandboxed) instance. */
async function writeFixtureParquet(n: number): Promise<string> {
  const path = join(tmpdir(), `kukan-test-${randomUUID()}.parquet`)
  const inst = await DuckDBInstance.create(':memory:')
  const conn = await inst.connect()
  await conn.run(
    `COPY (SELECT i AS id, 'name' || i AS name FROM range(${n}) t(i)) TO '${path}' (FORMAT parquet)`
  )
  conn.disconnectSync()
  inst.closeSync()
  return path
}

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

  it('returns column names and row objects', async () => {
    const res = await runSandboxedQuery(fixture, 'SELECT id, name FROM data ORDER BY id', LIMITS)
    expect(res.columns).toEqual(['id', 'name'])
    expect(res.rows[0]).toEqual({ id: '0', name: 'name0' })
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
