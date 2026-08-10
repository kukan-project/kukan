import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scrubbedExtras } from '@kukan/db'
import { checkBatch } from '../../cron/health-check/check-batch'
import * as headRequest from '../../cron/health-check/head-request'
import type { HeadCheckResult } from '../../cron/health-check/types'

// Mock executeHeadCheck
vi.mock('../../cron/health-check/head-request', () => ({
  executeHeadCheck: vi.fn(),
}))

// Mock config. The per-host bounds are shrunk so a case can drive them in
// milliseconds — loosely, not to scale; `@/config` is where the real numbers
// and their reasons are.
vi.mock('@/config', () => ({
  HEALTH_CHECK_BATCH_SIZE: 200,
  HEALTH_CHECK_CONCURRENCY: 10,
  HEALTH_CHECK_TIMEOUT_MS: 10_000,
  HEALTH_CHECK_PER_HOST_CONCURRENCY: 2,
  HEALTH_CHECK_PER_HOST_INTERVAL_MS: 20,
  HEALTH_CHECK_BATCH_BUDGET_MS: 60_000,
}))

function makeHeadResult(overrides: Partial<HeadCheckResult> = {}): HeadCheckResult {
  return {
    httpStatus: 200,
    healthStatus: 'ok',
    etag: '"v1"',
    lastModified: null,
    changed: false,
    errorMessage: null,
    errorDetail: null,
    ...overrides,
  }
}

function makeMockDb(rows: Record<string, unknown>[] = []) {
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  })

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: updateSet,
    }),
  }

  return Object.assign(db, { updateSet })
}

function makeMockQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue('job-1'),
    getStats: vi.fn(),
    process: vi.fn(),
    stop: vi.fn(),
  }
}

function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'silent',
    silent: vi.fn(),
  }
}

describe('checkBatch', () => {
  const mockExecuteHeadCheck = vi.mocked(headRequest.executeHeadCheck)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty summary when no stale resources', async () => {
    const db = makeMockDb([])
    const queue = makeMockQueue()
    const log = makeMockLogger()

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.total).toBe(0)
    expect(summary.checked).toBe(0)
    expect(log.debug).toHaveBeenCalledWith('No stale resources to check')
  })

  it('checks resources and updates health status', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult())

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.total).toBe(1)
    expect(summary.checked).toBe(1)
    expect(summary.ok).toBe(1)
    expect(summary.error).toBe(0)
    expect(summary.changed).toBe(0)
    expect(mockExecuteHeadCheck).toHaveBeenCalledOnce()
  })

  it('enqueues changed resources to pipeline', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'ok',
        healthCheckedAt: new Date(),
        healthCheckState: { etag: '"v1"' },
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult({ changed: true, etag: '"v2"' }))

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.changed).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith('resource-pipeline', { resourceId: 'res-1' })
  })

  it('takes the keys it used to write off extras as it writes', async () => {
    // What an overlapping old worker puts back, and why every check is a chance
    // to clear it: `LEGACY_HEALTH_EXTRAS_KEYS` in @kukan/db.
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)

    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult())

    await checkBatch(db as never, makeMockQueue(), 24, 168, makeMockLogger() as never)

    expect(db.updateSet.mock.calls[0][0].extras).toBe(scrubbedExtras)
  })

  it('enqueues no-header resources for periodic full fetch', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'ok',
        healthCheckedAt: new Date(),
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult({ etag: null, lastModified: null }))

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.enqueuedForFullFetch).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith('resource-pipeline', { resourceId: 'res-1' })
  })

  it('does not enqueue no-header resources within full fetch interval', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'ok',
        healthCheckedAt: new Date(),
        healthCheckState: { lastFullFetchAt: Date.now() },
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult({ etag: null, lastModified: null }))

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.enqueuedForFullFetch).toBe(0)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('refuses a URL the fetch would refuse before giving it a share of a host', async () => {
    // `mailto:` has no hostname; `ftp:` and a loopback address have one, and
    // that was the difference that mattered — keyed by host they took a place
    // in its queue and were paced through it, for a request `safeFetch` refuses
    // before it reaches a socket. Rows like these predate the check the API
    // applies at input, or arrived by import.
    const urls = [
      'mailto:someone@example.com',
      'ftp://one.example/a.csv',
      'ftp://one.example/b.csv',
      'ftp://one.example/c.csv',
      'ftp://one.example/d.csv',
      'http://localhost/a.csv',
    ]
    const rows = urls.map((url, i) => ({
      id: `res-${i}`,
      url,
      hash: null,
      healthStatus: 'unknown',
      healthCheckedAt: null,
      healthCheckState: {},
    }))

    const startedAt = Date.now()
    const summary = await checkBatch(
      makeMockDb(rows) as never,
      makeMockQueue(),
      24,
      168,
      makeMockLogger() as never
    )

    expect(summary.error).toBe(6)
    expect(mockExecuteHeadCheck).not.toHaveBeenCalled()
    // And not paced against each other: four rows on one host would otherwise
    // cost three intervals to say no to, and two hundred would cost the batch.
    expect(Date.now() - startedAt).toBeLessThan(3 * 20)
  })

  it('handles invalid URLs gracefully', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'not-a-valid-url',
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.checked).toBe(1)
    expect(summary.error).toBe(1)
    expect(mockExecuteHeadCheck).not.toHaveBeenCalled()
  })

  it('does not enqueue error resources for full fetch', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'ok',
        healthCheckedAt: new Date(),
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(
      makeHeadResult({
        healthStatus: 'error',
        httpStatus: 500,
        etag: null,
        lastModified: null,
        errorMessage: 'HTTP 500 Internal Server Error',
      })
    )

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.error).toBe(1)
    expect(summary.enqueuedForFullFetch).toBe(0)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('counts error results correctly', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      },
    ]
    const db = makeMockDb(rows)
    const queue = makeMockQueue()
    const log = makeMockLogger()

    mockExecuteHeadCheck.mockResolvedValue(
      makeHeadResult({
        healthStatus: 'error',
        httpStatus: 404,
        errorMessage: 'HTTP 404 Not Found',
      })
    )

    const summary = await checkBatch(db as never, queue, 24, 168, log as never)

    expect(summary.ok).toBe(0)
    expect(summary.error).toBe(1)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })
  // What the batch owes the hosts it reaches. A catalog's URLs are not spread
  // evenly: measured on a live site, 477 of 481 external URLs were one host,
  // and the unpaced batch had 305 of them answering 403 — resources that
  // returned 200 when asked one at a time.
  describe('the budget it keeps per host', () => {
    const rowsFor = (urls: string[]) =>
      urls.map((url, i) => ({
        id: `res-${i}`,
        url,
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      }))

    it('keeps one host under the per-host limit however long the batch is', async () => {
      const rows = rowsFor(Array.from({ length: 12 }, (_, i) => `https://one.example/${i}.csv`))
      let inFlight = 0
      let peak = 0
      // Longer than the interval, or the pacing alone would hold it to one in
      // flight and the semaphore would never be the thing under test.
      mockExecuteHeadCheck.mockImplementation(async () => {
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 100))
        inFlight--
        return makeHeadResult()
      })

      const summary = await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(summary.checked).toBe(12)
      // Exactly the cap, not merely under it: an implementation that ignored
      // the constant and serialized the host would satisfy `<= 2` as well.
      expect(peak).toBe(2)
    })

    it('spaces requests to one host out even when they answer instantly', async () => {
      const rows = rowsFor(Array.from({ length: 4 }, (_, i) => `https://one.example/${i}.csv`))
      const starts: number[] = []
      mockExecuteHeadCheck.mockImplementation(async () => {
        starts.push(Date.now())
        return makeHeadResult()
      })

      await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      // Four requests, one reservation each: the last leaves three intervals
      // after the first. Compared with a tolerance rather than exactly, since a
      // timer may fire a millisecond early — unpaced this difference is zero.
      expect(starts).toHaveLength(4)
      expect(starts[3] - starts[0]).toBeGreaterThan(2 * 20)
    })

    it('still spaces one host out when every overall slot is busy', async () => {
      // Measured with the wait taken before the overall slot instead of inside
      // it: six requests to one host left within 3ms of each other against a
      // 50ms floor. A request paced before it queues is paced against the
      // moment it joined the queue, and the queue releases what it holds
      // together.
      const busy = Array.from({ length: 10 }, (_, i) => `https://slow${i % 5}.example/${i}.csv`)
      const paced = Array.from({ length: 6 }, (_, i) => `https://one.example/${i}.csv`)
      const starts: number[] = []
      mockExecuteHeadCheck.mockImplementation(async (res: { url: string }) => {
        if (new URL(res.url).hostname === 'one.example') starts.push(Date.now())
        else await new Promise((r) => setTimeout(r, 120))
        return makeHeadResult()
      })

      await checkBatch(
        makeMockDb(rowsFor([...busy, ...paced])) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(starts).toHaveLength(6)
      const gaps = starts.slice(1).map((t, i) => t - starts[i])
      expect(gaps.filter((gap) => gap <= 10)).toEqual([])
    })

    it('treats a name and the same name with a trailing dot as one host', async () => {
      const rows = rowsFor(['https://one.example/a.csv', 'https://one.example./b.csv'])
      const starts: number[] = []
      mockExecuteHeadCheck.mockImplementation(async () => {
        starts.push(Date.now())
        return makeHeadResult()
      })

      await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(starts[1] - starts[0]).toBeGreaterThan(10)
    })

    it('bounds the writes as well as the requests', async () => {
      // The overall limiter used to wrap the whole of each row's work and now
      // wraps what it is allowed to; the writes go to a pool of three shared
      // with the pipeline, so leaving them outside is not a free simplification.
      let inFlight = 0
      let peak = 0
      const rows = rowsFor(Array.from({ length: 30 }, () => 'not-a-url'))
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              peak = Math.max(peak, ++inFlight)
              await new Promise((r) => setTimeout(r, 5))
              inFlight--
            }),
          }),
        }),
      }

      const summary = await checkBatch(
        db as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(summary.error).toBe(30)
      expect(peak).toBe(10)
    })

    it('keeps spacing across a stall of the event loop', async () => {
      // Reserved ahead of the wait, several turns fall due together while the
      // loop is stopped and the requests they were pacing leave together on the
      // other side. Measured that way against a 100ms floor across a 300ms
      // stall: four requests left at 0, 350, 350, 350.
      const rows = rowsFor(Array.from({ length: 4 }, (_, i) => `https://one.example/${i}.csv`))
      const starts: number[] = []
      mockExecuteHeadCheck.mockImplementation(async () => {
        starts.push(Date.now())
        // Stopped from inside the first check rather than by a timer of its
        // own, which would have to land in a window this cannot see: here the
        // second row is waiting out its turn by construction.
        if (starts.length === 1) {
          const until = Date.now() + 90
          while (Date.now() < until) {
            /* the loop is not going anywhere */
          }
        }
        return makeHeadResult()
      })

      await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      starts.sort((a, b) => a - b)
      const gaps = starts.slice(1).map((t, i) => t - starts[i])
      expect(starts).toHaveLength(4)
      expect(gaps.filter((gap) => gap <= 10)).toEqual([])
    })

    it('paces a host a redirect reached, not only the one the row named', async () => {
      // The registered hosts are all distinct, so nothing in their own budgets
      // spaces them; without the hook they arrive at the target together.
      const rows = rowsFor(Array.from({ length: 2 }, (_, i) => `https://site${i}.example/a.csv`))
      const arrivals: number[] = []
      mockExecuteHeadCheck.mockImplementation(async (_res, hooks) => {
        // What `safeFetch` asks at each host the chain has not used yet.
        if (hooks?.onHost && !(await hooks.onHost('cdn.example'))) return null
        arrivals.push(Date.now())
        return makeHeadResult()
      })

      const summary = await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(arrivals).toHaveLength(2)
      expect(arrivals[1] - arrivals[0]).toBeGreaterThan(10)
      expect(summary.error).toBe(0)
    })

    it('gives a redirect target back its slot when the request ends', async () => {
      // One origin host, so its own pacing staggers the arrivals: each reaches
      // the target after the one before it has finished with it. Held onto,
      // the first two would take the target's slots and the rest would find
      // none free ever again.
      const rows = rowsFor(Array.from({ length: 4 }, (_, i) => `https://one.example/${i}.csv`))
      const arrivals: string[] = []
      mockExecuteHeadCheck.mockImplementation(async (res: { url: string }, hooks) => {
        if (hooks?.onHost && !(await hooks.onHost('cdn.example'))) return null
        arrivals.push(res.url)
        return makeHeadResult()
      })

      const summary = await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(arrivals).toHaveLength(4)
      expect(summary.deferred).toBe(0)
    })

    it('waits briefly for a redirect target rather than throwing the request away', async () => {
      // Refused outright, a batch of rows on distinct hosts behind one CDN
      // spends every one of its requests to record almost none of them:
      // measured with the production numbers, 200 origin requests recorded 6
      // rows and the batch left 234 of its 240 seconds unused.
      const rows = rowsFor(Array.from({ length: 4 }, (_, i) => `https://site${i}.example/a.csv`))
      mockExecuteHeadCheck.mockImplementation(async (_res, hooks) => {
        if (hooks?.onHost && !(await hooks.onHost('cdn.example'))) return null
        await new Promise((r) => setTimeout(r, 5))
        return makeHeadResult()
      })

      const summary = await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      // More than the cap gets through, which is what waiting buys: refused
      // outright it is exactly the cap and no more, however long the batch has.
      expect(summary.checked).toBeGreaterThan(2)
    })

    it('defers a row whose redirect target is already at its limit', async () => {
      // Ten rows on ten hosts redirecting to one unresponsive target used to
      // pile ten requests onto it, a second apart, until every overall slot was
      // gone — the cap this budget promises, walked around by a `Location`.
      const rows = rowsFor(Array.from({ length: 8 }, (_, i) => `https://site${i}.example/a.csv`))
      let inFlight = 0
      let peak = 0
      mockExecuteHeadCheck.mockImplementation(async (_res, hooks) => {
        if (hooks?.onHost && !(await hooks.onHost('cdn.example'))) return null
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 60))
        inFlight--
        return makeHeadResult()
      })

      const summary = await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(peak).toBeLessThanOrEqual(2)
      // Refused, not recorded: the resource is fine, it simply was not asked.
      expect(summary.deferred).toBeGreaterThan(0)
      expect(summary.checked + summary.deferred).toBe(8)
      expect(summary.error).toBe(0)
    })

    it('lets another host through while one host is waiting its turn', async () => {
      // The regression this is here for: taking the global slot before the
      // host's leaves every slot held by a task waiting on the same host, and
      // nothing else in the batch is ever asked. The batch is read in staleness
      // order, which is what puts one host's URLs together like this.
      const crowded = Array.from({ length: 30 }, (_, i) => `https://one.example/${i}.csv`)
      const rows = rowsFor([...crowded, 'https://other.example/late.csv'])
      const finished: string[] = []
      mockExecuteHeadCheck.mockImplementation(async (res: { url: string }) => {
        await new Promise((r) => setTimeout(r, 5))
        finished.push(new URL(res.url).hostname)
        return makeHeadResult()
      })

      await checkBatch(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      // Not merely that it ran: that it ran early, rather than after the
      // crowded host had worked through its thirty.
      expect(finished.indexOf('other.example')).toBeLessThan(5)
    })
  })

  it('defers a turn that the event loop stopping pushed past the deadline', async () => {
    // The first test of the deadline is a prediction: the turn was inside it
    // when it was worked out. A timer that comes back after the loop stopped
    // comes back late, and sending anyway means sending on a signal that has
    // already fired — recorded against the resource rather than deferred.
    vi.resetModules()
    vi.doMock('@/config', () => ({
      HEALTH_CHECK_BATCH_SIZE: 200,
      HEALTH_CHECK_CONCURRENCY: 10,
      HEALTH_CHECK_TIMEOUT_MS: 10_000,
      HEALTH_CHECK_PER_HOST_CONCURRENCY: 2,
      HEALTH_CHECK_PER_HOST_INTERVAL_MS: 100,
      // The second row's turn falls at 100ms, inside this; the stall in the
      // first check carries it out the other side.
      HEALTH_CHECK_BATCH_BUDGET_MS: 150,
    }))
    try {
      const { checkBatch: budgeted } = await import('../../cron/health-check/check-batch')

      const rows = Array.from({ length: 2 }, (_, i) => ({
        id: `res-${i}`,
        url: `https://one.example/${i}.csv`,
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      }))
      let checks = 0
      mockExecuteHeadCheck.mockImplementation(async () => {
        if (++checks === 1) {
          const until = Date.now() + 250
          while (Date.now() < until) {
            /* the loop is not going anywhere */
          }
        }
        return makeHeadResult()
      })

      const summary = await budgeted(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(summary.checked).toBe(1)
      expect(summary.deferred).toBe(1)
      expect(summary.error).toBe(0)
    } finally {
      vi.doUnmock('@/config')
      vi.resetModules()
    }
  })

  it('will not start a hop with a sliver of the timeout left', async () => {
    // A hop that leaves near the deadline is answered by its own abort, and the
    // live URL behind it is written down as a dead link. The bound is on
    // starting one, so it is half of what the request is given: at the whole of
    // it, a turn landing exactly on the deadline is allowed through.
    vi.resetModules()
    vi.doMock('@/config', () => ({
      HEALTH_CHECK_BATCH_SIZE: 200,
      HEALTH_CHECK_CONCURRENCY: 10,
      HEALTH_CHECK_PER_HOST_CONCURRENCY: 2,
      HEALTH_CHECK_BATCH_BUDGET_MS: 60_000,
      // The second row's turn at the target falls at 100ms — past half of the
      // timeout, inside the whole of it.
      HEALTH_CHECK_PER_HOST_INTERVAL_MS: 100,
      HEALTH_CHECK_TIMEOUT_MS: 100,
    }))
    try {
      const { checkBatch: impatient } = await import('../../cron/health-check/check-batch')

      const rows = Array.from({ length: 2 }, (_, i) => ({
        id: `res-${i}`,
        url: `https://site${i}.example/a.csv`,
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        healthCheckState: {},
      }))
      mockExecuteHeadCheck.mockImplementation(async (_res, hooks) => {
        if (hooks?.onHost && !(await hooks.onHost('cdn.example'))) return null
        return makeHeadResult()
      })

      const summary = await impatient(
        makeMockDb(rows) as never,
        makeMockQueue(),
        24,
        168,
        makeMockLogger() as never
      )

      expect(summary.checked).toBe(1)
      expect(summary.deferred).toBe(1)
      expect(summary.error).toBe(0)
    } finally {
      vi.doUnmock('@/config')
      vi.resetModules()
    }
  })

  it('defers what it could not start before the batch ran out of budget', async () => {
    vi.resetModules()
    vi.doMock('@/config', () => ({
      HEALTH_CHECK_BATCH_SIZE: 200,
      HEALTH_CHECK_CONCURRENCY: 10,
      HEALTH_CHECK_TIMEOUT_MS: 10_000,
      HEALTH_CHECK_PER_HOST_CONCURRENCY: 1,
      HEALTH_CHECK_PER_HOST_INTERVAL_MS: 20,
      HEALTH_CHECK_BATCH_BUDGET_MS: 50,
    }))
    const { checkBatch: budgeted } = await import('../../cron/health-check/check-batch')

    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `res-${i}`,
      url: `https://slow.example/${i}.csv`,
      hash: null,
      healthStatus: 'unknown',
      healthCheckedAt: null,
      healthCheckState: {},
    }))
    mockExecuteHeadCheck.mockResolvedValue(makeHeadResult())

    const startedAt = Date.now()
    const summary = await budgeted(
      makeMockDb(rows) as never,
      makeMockQueue(),
      24,
      168,
      makeMockLogger() as never
    )
    const elapsed = Date.now() - startedAt

    // Left alone rather than checked, and the row keeps the healthCheckedAt it
    // had — so the next tick reads it first and the batch goes on from here.
    // Both halves: a batch that checked nothing at all would satisfy the
    // deferred count on its own.
    expect(summary.checked).toBeGreaterThan(0)
    expect(summary.deferred).toBeGreaterThan(0)
    expect(summary.checked + summary.deferred).toBe(20)
    // And left alone cheaply: a turn already known to be too late is refused
    // rather than waited out, or twenty rows on one host would cost twenty
    // intervals to say no to.
    expect(elapsed).toBeLessThan(20 * 20)
    vi.doUnmock('@/config')
    vi.resetModules()
  })
})
