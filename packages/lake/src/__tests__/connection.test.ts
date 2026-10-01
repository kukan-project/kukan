import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { LakeConfig } from '../config'
import type { LakeSession } from '../connection'

/**
 * A DuckDB stood in by a stub: what these pin is the instance cache around it —
 * which failures drop the instance, and that `withLakeSession` runs its work
 * once more on a fresh one when asked — not anything DuckDB does.
 */
const instances: { closeSync: Mock; options: Record<string, string>; ran: string[] }[] = []
/** Per instance, in creation order: what its connections throw from `run`. */
let failWith: (instanceIndex: number, sql: string) => Error | undefined
/** Whether the n-th `connect()` (1-based; setup takes the first) on the
 *  instance at that index is refused. */
let refuseConnect: (instanceIndex: number, nth: number) => boolean

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: async (_path: string, options: Record<string, string>) => {
      const index = instances.length
      let connects = 0
      const ran: string[] = []
      const instance = {
        closeSync: vi.fn(),
        options,
        ran,
        connect: async () => {
          connects += 1
          if (refuseConnect(index, connects)) throw new Error('Failed to connect: instance closed')
          return {
            run: async (sql: string) => {
              ran.push(sql)
              const err = failWith(index, sql)
              if (err) throw err
            },
            runAndReadAll: async () => ({ getRowObjectsJson: () => [{ value: '0' }] }),
            disconnectSync: () => {},
            interrupt: () => {},
          }
        },
      }
      instances.push(instance)
      return instance
    },
  },
}))

const { withLakeSession, closeLakeInstances } = await import('../connection')

const config: LakeConfig = {
  pgConnString: 'host=x',
  bucket: 'b',
  region: 'r',
  s3UseSsl: false,
  limits: { memoryLimitMb: 512, threads: 2, catalogConnections: 2 },
}
const work = 'SELECT 1'
const rerun = { rerunIfLost: true }

const failFirstInstance = (message: string) => {
  failWith = (i, sql) => (i === 0 && sql === work ? new Error(message) : undefined)
}
const failEveryInstance = (message: string) => {
  failWith = (_i, sql) => (sql === work ? new Error(message) : undefined)
}
const runsWork = () => vi.fn(async (session: Pick<LakeSession, 'run'>) => session.run(work))

beforeEach(async () => {
  await closeLakeInstances()
  instances.length = 0
  failWith = () => undefined
  refuseConnect = () => false
})

describe('withLakeSession', () => {
  it('runs the work once more on a fresh instance when the instance was lost', async () => {
    failFirstInstance('ExpiredToken: The provided token has expired.')
    const fn = runsWork()

    await withLakeSession(config, fn, rerun)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(instances).toHaveLength(2)
    // The lost instance is closed, not just forgotten: it holds worker threads
    // and the catalog's libpq connection.
    expect(instances[0].closeSync).toHaveBeenCalled()
    expect(instances[1].closeSync).not.toHaveBeenCalled()
  })

  it('returns what the second run returned, and tells the work which run it is', async () => {
    failFirstInstance('ExpiredToken')
    const attempts: number[] = []
    const fn = async (session: Pick<LakeSession, 'run'>, attempt: number) => {
      attempts.push(attempt)
      await session.run(work)
      return `run ${attempt}`
    }

    await expect(withLakeSession(config, fn, rerun)).resolves.toBe('run 2')
    expect(attempts).toEqual([1, 2])
  })

  it('does not rerun unless asked, though the instance is still dropped', async () => {
    failFirstInstance('ExpiredToken')
    const fn = runsWork()

    await expect(withLakeSession(config, fn)).rejects.toThrow('ExpiredToken')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(instances[0].closeSync).toHaveBeenCalled()

    // The next caller gets a fresh instance rather than the dead one.
    await withLakeSession(config, runsWork())
    expect(instances).toHaveLength(2)
  })

  it('reports a second loss rather than retrying again', async () => {
    failEveryInstance('server closed the connection')
    const fn = runsWork()

    await expect(withLakeSession(config, fn, rerun)).rejects.toThrow('server closed')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(instances).toHaveLength(2)
  })

  it('does not retry a statement that was merely wrong', async () => {
    failEveryInstance('Binder Error: no such column')
    const fn = runsWork()

    await expect(withLakeSession(config, fn, rerun)).rejects.toThrow('Binder Error')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].closeSync).not.toHaveBeenCalled()
  })

  it('keeps the instance when a session only waited out the catalog pool', async () => {
    failFirstInstance('Connection pool timeout: all 2 connections in use')

    await expect(withLakeSession(config, runsWork(), rerun)).rejects.toThrow('pool timeout')
    expect(instances).toHaveLength(1)
    expect(instances[0].closeSync).not.toHaveBeenCalled()
  })

  it("does not retry on the work's own failure, even one that reads like a lost instance", async () => {
    // A Postgres transaction inside the work dropping its connection says
    // "connection" too, and says nothing about the DuckDB instance.
    const fn = vi.fn(async () => {
      throw new Error('Connection terminated unexpectedly')
    })

    await expect(withLakeSession(config, fn, rerun)).rejects.toThrow('Connection terminated')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(instances[0].closeSync).not.toHaveBeenCalled()
  })

  it('treats a connect refused by a closed instance as the instance being lost', async () => {
    // Another session's loss closed the instance while this caller already
    // held it out of the cache; its connect fails, and that is the same loss.
    refuseConnect = (i, nth) => i === 0 && nth === 2
    const fn = runsWork()

    await withLakeSession(config, fn, rerun)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(2)
    expect(instances[0].closeSync).toHaveBeenCalled()
  })

  it('keeps the rebuilt instance for the sessions after it', async () => {
    failFirstInstance('ExpiredToken')

    await withLakeSession(config, runsWork(), rerun)
    await withLakeSession(config, runsWork(), rerun)

    expect(instances).toHaveLength(2)
  })
})

describe('the instance', () => {
  it('is bounded by the config, and shared by every session on it', async () => {
    await withLakeSession(config, runsWork())
    await withLakeSession(config, runsWork())

    expect(instances).toHaveLength(1)
    expect(instances[0].options).toMatchObject({ memory_limit: '512000000B', threads: '2' })
  })

  it('caps the catalog connections, and waits past the cap, before the ATTACH', async () => {
    await withLakeSession(config, runsWork())

    const { ran } = instances[0]
    const attach = ran.findIndex((sql) => sql.startsWith('ATTACH'))
    const max = ran.indexOf('SET pg_pool_max_connections = 2')
    const wait = ran.indexOf(`SET pg_pool_acquire_mode = 'wait'`)
    const timeout = ran.findIndex((sql) => sql.startsWith('SET pg_pool_wait_timeout_millis'))
    for (const set of [max, wait, timeout]) {
      expect(set).toBeGreaterThanOrEqual(0)
      expect(set).toBeLessThan(attach)
    }
  })
})
