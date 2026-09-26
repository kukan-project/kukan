import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { ChildProcess, ForkOptions } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'
import { RequestAbandonedError, RequestTimeoutError, ValidationError } from '@kukan/shared'
import { writeParquet } from '../../test-helpers/parquet'
import type { SandboxLimits } from '../../../services/query/duckdb-sandbox'
import { QUERY_WEB_HEADROOM_MB } from '../../../config'

// The processes the module under test starts, so a test can reach one the way
// the kernel would
const spawned: { child: ChildProcess; options: ForkOptions }[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: (modulePath: string, args: string[], options: ForkOptions) => {
      const child = actual.fork(modulePath, args, options)
      spawned.push({ child, options })
      return child
    },
  }
})

const { runQueryInProcess, childEnvironment, overBudget } =
  await import('../../../services/query/query-process')

const LIMITS: SandboxLimits = {
  maxRows: 10,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  memoryLimitMb: 256,
  threads: 2,
}

// Big enough that a cross join of it runs for longer than any test waits
const SLOW_SQL =
  'SELECT max(a.id + b.id + c.id + d.id + e.id) FROM data a, data b, data c, data d, data e'

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out waiting')
}

const exitOf = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once('exit', r))

describe('runQueryInProcess', () => {
  let fixture: string

  beforeAll(async () => {
    fixture = await writeParquet(`SELECT i AS id, 'name' || i AS name FROM range(100) t(i)`)
  })

  afterAll(async () => {
    await unlink(fixture).catch(() => {})
  })

  beforeEach(() => {
    spawned.length = 0
  })

  it('answers the query from a process of its own, which is gone afterwards', async () => {
    const res = await runQueryInProcess(fixture, 'SELECT count(*) AS c FROM data', LIMITS)
    expect(res).toEqual({ columns: ['c'], rows: [{ c: '100' }], rowCount: 1, truncated: false })
    expect(spawned).toHaveLength(1)
    await exitOf(spawned[0].child)
    expect(spawned[0].child.exitCode).toBe(0)
  })

  it('keeps the result limits, which the child applies', async () => {
    const res = await runQueryInProcess(fixture, 'SELECT * FROM data', LIMITS)
    expect(res.truncated).toBe(true)
    expect(res.rowCount).toBe(LIMITS.maxRows)
  })

  it('rebuilds a refusal from the child as the same error class', async () => {
    await expect(
      runQueryInProcess(fixture, 'SELECT nonexistent_col FROM data', LIMITS)
    ).rejects.toThrow(ValidationError)
    // The lockdown holds in the child as it did in process
    await expect(
      runQueryInProcess(fixture, "SELECT * FROM read_csv('/etc/hostname')", LIMITS)
    ).rejects.toThrow(/file system operations are disabled/)
  })

  it('answers 408 when the child interrupts its own statement', async () => {
    await expect(
      runQueryInProcess(fixture, SLOW_SQL, { ...LIMITS, timeoutMs: 200 })
    ).rejects.toThrow(RequestTimeoutError)
  })

  it('kills the process once its RSS passes the budget, and says the query was too big', async () => {
    // A fresh child with DuckDB loaded is already over this
    await expect(runQueryInProcess(fixture, SLOW_SQL, LIMITS, { rssBudgetMb: 20 })).rejects.toThrow(
      /more memory than this server had free/
    )
    expect(spawned[0].child.signalCode).toBe('SIGKILL')
  })

  it('takes a SIGKILL it did not send for the kernel, and says the query was too big', async () => {
    const running = runQueryInProcess(fixture, SLOW_SQL, LIMITS)
    const { child } = await waitFor(() => spawned[0])
    // Let it reach the query, so this is not a spawn failure
    await new Promise((r) => setTimeout(r, 500))
    child.kill('SIGKILL')
    await expect(running).rejects.toThrow(/more memory than this server had free/)
  })

  it('stops the process when the caller leaves', async () => {
    const controller = new AbortController()
    const running = runQueryInProcess(fixture, SLOW_SQL, LIMITS, { signal: controller.signal })
    const { child } = await waitFor(() => spawned[0])
    await new Promise((r) => setTimeout(r, 500))
    controller.abort()
    await expect(running).rejects.toThrow(RequestAbandonedError)
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('starts nothing for a caller that has already left', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runQueryInProcess(fixture, 'SELECT 1', LIMITS, { signal: controller.signal })
    ).rejects.toThrow(RequestAbandonedError)
    expect(spawned).toHaveLength(0)
  })

  it('removes the spill directory of a process it killed', async () => {
    await expect(
      runQueryInProcess(fixture, SLOW_SQL, LIMITS, { rssBudgetMb: 20 })
    ).rejects.toThrow()
    const tmp = spawned[0].options.env?.TMPDIR
    expect(tmp).toContain('kukan-query-proc-')
    await expect(stat(tmp!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'linux')(
    'makes the query the process the OOM killer picks first',
    async () => {
      const controller = new AbortController()
      const running = runQueryInProcess(fixture, SLOW_SQL, LIMITS, {
        signal: controller.signal,
      }).catch(() => {})
      const { child } = await waitFor(() => spawned[0])
      const score = await waitFor(async () => {
        const v = (await readFile(`/proc/${child.pid}/oom_score_adj`, 'utf8')).trim()
        return v === '1000' ? v : undefined
      })
      controller.abort()
      await running
      expect(score).toBe('1000')
    }
  )
})

describe('childEnvironment', () => {
  it('passes what loading DuckDB needs and none of the web server’s secrets', () => {
    const env = childEnvironment(
      {
        PATH: '/usr/bin',
        LD_LIBRARY_PATH: '/app/duckdb-lib',
        DUCKDB_EXTENSION_DIRECTORY: '/app/duckdb-extensions',
        AWS_ACCESS_KEY_ID: 'AKIAPROBE',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/probe',
        DATABASE_URL: 'postgres://u:p@db/kukan',
        BETTER_AUTH_SECRET: 'auth',
        HTTP_PROXY: 'http://user:pass@proxy:8080',
      },
      '/tmp/kukan-query-proc-x'
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/app/duckdb-lib',
      DUCKDB_EXTENSION_DIRECTORY: '/app/duckdb-extensions',
      TMPDIR: '/tmp/kukan-query-proc-x',
    })
  })
})

describe('overBudget', () => {
  it('stops a query past its own budget, wherever it runs', () => {
    expect(overBudget(600, null, 588, 16_384)).toBe(true)
    expect(overBudget(500, null, 588, 16_384)).toBe(false)
  })

  it('stops a query once the container nears its limit, whatever the query holds', () => {
    // A 512 MB task: the web server and the query together, as the OOM killer counts them
    expect(overBudget(250, 512 - QUERY_WEB_HEADROOM_MB + 1, 588, 512)).toBe(true)
    expect(overBudget(250, 512 - QUERY_WEB_HEADROOM_MB - 1, 588, 512)).toBe(false)
  })
})
