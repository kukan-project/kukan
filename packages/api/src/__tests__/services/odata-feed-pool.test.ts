import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Env } from '@kukan/shared'
import type { DuckdbHandle } from '@kukan/lake'
import { createFeedPool } from '../../services/odata/feed-pool'

// What an instance is set to, and that it still holds on a later connection,
// is `odata-session.test.ts`'s; this is only the lending.

const at = (location: string) => ({
  location,
  env: {} as Env,
  memoryLimitBytes: 64_000_000,
  readTimeoutMs: 15_000,
})

/** An instance that only records what was done to it. */
function fakeInstance() {
  const closeSync = vi.fn()
  const dropTempDir = vi.fn(async () => {})
  const conn = () => ({ disconnectSync: vi.fn() })
  const handle = {
    instance: { connect: vi.fn(async () => conn()), closeSync },
    conn: conn(),
    dropTempDir,
  } as unknown as DuckdbHandle
  return { handle, closeSync, dropTempDir }
}

function poolOf(instances: ReturnType<typeof fakeInstance>[], opts = {}) {
  const prepare = vi.fn(async () => {
    const next = instances.shift()
    if (!next) throw new Error('prepared more instances than the test expected')
    return next.handle
  })
  return { prepare, pool: createFeedPool({ prepare, idleMs: 60_000, maxAgeMs: 900_000, ...opts }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createFeedPool', () => {
  it('serves the next page from the instance the last one handed back', async () => {
    const one = fakeInstance()
    const { prepare, pool } = poolOf([one])

    await (await pool.acquire(at('s3://b/one.parquet'))).release(true)
    await (await pool.acquire(at('s3://b/two.parquet'))).release(true)

    expect(prepare).toHaveBeenCalledOnce()
    await pool.drain()
    expect(one.closeSync).toHaveBeenCalledOnce()
  })

  it('closes an instance handed back as not reusable', async () => {
    const [one, two] = [fakeInstance(), fakeInstance()]
    const { prepare, pool } = poolOf([one, two])

    await (await pool.acquire(at('s3://b/x.parquet'))).release(false)
    expect(one.closeSync).toHaveBeenCalledOnce()
    expect(one.dropTempDir).toHaveBeenCalledOnce()

    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    expect(prepare).toHaveBeenCalledTimes(2)
    await pool.drain()
  })

  it('never lends an instance prepared for another bucket', async () => {
    // The secret is scoped to the bucket the instance was prepared for.
    const { prepare, pool } = poolOf([fakeInstance(), fakeInstance(), fakeInstance()])

    await (await pool.acquire(at('s3://a/x.parquet'))).release(true)
    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    await (await pool.acquire(at('/tmp/x.parquet'))).release(true)

    expect(prepare).toHaveBeenCalledTimes(3)
    await pool.drain()
  })

  it('closes an instance left unused for the idle period', async () => {
    vi.useFakeTimers()
    const one = fakeInstance()
    const { pool } = poolOf([one], { idleMs: 1_000 })

    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(one.closeSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(one.closeSync).toHaveBeenCalledOnce()
  })

  it('does not close an instance taken again before the idle period ran out', async () => {
    vi.useFakeTimers()
    const one = fakeInstance()
    const { pool } = poolOf([one], { idleMs: 1_000 })

    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    await vi.advanceTimersByTimeAsync(500)
    const lease = await pool.acquire(at('s3://b/x.parquet'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(one.closeSync).not.toHaveBeenCalled()

    await lease.release(true)
    await pool.drain()
  })

  it('retires an instance past its age, however busy', async () => {
    // Steady traffic never lets the idle period run out; the age bounds how
    // long one secret is trusted to refresh itself.
    vi.useFakeTimers()
    const [one, two] = [fakeInstance(), fakeInstance()]
    const { prepare, pool } = poolOf([one, two], { maxAgeMs: 10_000 })

    for (let i = 0; i < 9; i++) {
      await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(prepare).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    expect(one.closeSync).toHaveBeenCalledOnce()

    await (await pool.acquire(at('s3://b/x.parquet'))).release(true)
    expect(prepare).toHaveBeenCalledTimes(2)
    await pool.drain()
  })

  it('ignores a second release of the same lease', async () => {
    const { prepare, pool } = poolOf([fakeInstance(), fakeInstance()])

    const lease = await pool.acquire(at('s3://b/x.parquet'))
    await lease.release(true)
    await lease.release(true)
    // Kept once, so two leases at once need a second instance.
    await pool.acquire(at('s3://b/x.parquet'))
    await pool.acquire(at('s3://b/x.parquet'))
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})
