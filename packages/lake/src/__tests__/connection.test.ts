import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { LakeConfig } from '../config'
import type { BucketSession } from '../connection'

/**
 * A DuckDB stood in by a stub: what these pin is the instance cache around it —
 * which failures drop the instance, and that the next session gets a fresh
 * one — not anything DuckDB does.
 */
const instances: { closeSync: Mock; options: Record<string, string>; ran: string[] }[] = []
/** Per instance, in creation order: what its connections throw from `run`. */
let failWith: (instanceIndex: number, sql: string) => Error | undefined
/** Whether the n-th `connect()` (1-based; setup takes the first) on the
 *  instance at that index is refused. */
let refuseConnect: (instanceIndex: number, nth: number) => boolean

vi.mock('@duckdb/node-api', () => ({
  // What `rowObjectsJson` imports; the stub's reader ignores the converter
  DuckDBTypeId: {},
  JsonDuckDBValueConverter: () => null,
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
            runAndReadAll: async (sql: string) => {
              ran.push(sql)
              const err = failWith(index, sql)
              if (err) throw err
              return { convertRowObjects: () => [{ value: '0' }] }
            },
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

const { withBucketSession, closeLakeInstances } = await import('../connection')

const config: LakeConfig = {
  bucket: 'b',
  region: 'r',
  s3UseSsl: false,
  limits: { memoryLimitMb: 512, threads: 2 },
}
const work = 'SELECT 1'

const failFirstInstance = (message: string) => {
  failWith = (i, sql) => (i === 0 && sql === work ? new Error(message) : undefined)
}
const failEveryInstance = (message: string) => {
  failWith = (_i, sql) => (sql === work ? new Error(message) : undefined)
}
const runsWork = () => vi.fn(async (session: Pick<BucketSession, 'run'>) => session.run(work))

beforeEach(async () => {
  await closeLakeInstances()
  instances.length = 0
  failWith = () => undefined
  refuseConnect = () => false
})

describe('a lost instance', () => {
  it('is closed and dropped, and the next session gets a fresh one', async () => {
    failFirstInstance('ExpiredToken: The provided token has expired.')

    await expect(withBucketSession(config, runsWork())).rejects.toThrow('ExpiredToken')
    // Closed, not just forgotten: it holds worker threads
    expect(instances[0].closeSync).toHaveBeenCalled()

    await withBucketSession(config, runsWork())
    expect(instances).toHaveLength(2)
    expect(instances[1].closeSync).not.toHaveBeenCalled()
  })

  it('is not what a statement that was merely wrong means', async () => {
    failEveryInstance('Binder Error: no such column')

    await expect(withBucketSession(config, runsWork())).rejects.toThrow('Binder Error')
    await withBucketSession(config, async () => {})
    expect(instances).toHaveLength(1)
    expect(instances[0].closeSync).not.toHaveBeenCalled()
  })

  it("is not what the work's own failure means, even one that reads like it", async () => {
    // A Postgres transaction inside the work dropping its connection says
    // "connection" too, and says nothing about the DuckDB instance.
    const fn = vi.fn(async () => {
      throw new Error('Connection terminated unexpectedly')
    })

    await expect(withBucketSession(config, fn)).rejects.toThrow('Connection terminated')
    expect(instances[0].closeSync).not.toHaveBeenCalled()
  })

  it('is what a catalog left half-detached by another session means', async () => {
    // The alias is another session's: what it left fails any statement that
    // lists the instance's catalogs, whichever catalog the session works on
    failFirstInstance(
      'Binder Error: Failed to query most recent snapshot for DuckLake: ' +
        'Catalog "__ducklake_metadata_lake_d005df31ee52" does not exist!'
    )

    await expect(withBucketSession(config, runsWork())).rejects.toThrow('does not exist')
    expect(instances[0].closeSync).toHaveBeenCalled()

    await withBucketSession(config, runsWork())
    expect(instances).toHaveLength(2)
  })

  it('is what a connect refused by a closed instance means', async () => {
    // Another session's loss closed the instance while this caller already
    // held it out of the cache; its connect fails, and that is the same loss.
    refuseConnect = (i, nth) => i === 0 && nth === 2

    await expect(withBucketSession(config, runsWork())).rejects.toThrow('instance closed')
    await withBucketSession(config, runsWork())
    expect(instances).toHaveLength(2)
    expect(instances[0].closeSync).toHaveBeenCalled()
  })
})

describe('the instance', () => {
  it('is bounded by the config, and shared by every session on it', async () => {
    await withBucketSession(config, runsWork())
    await withBucketSession(config, runsWork())

    expect(instances).toHaveLength(1)
    expect(instances[0].options).toMatchObject({ memory_limit: '512000000B', threads: '2' })
  })

  it('loads no extension for a catalog in PostgreSQL', async () => {
    await withBucketSession(config, runsWork())

    expect(instances[0].ran.some((sql) => /\bpostgres\b/.test(sql))).toBe(false)
  })
})
