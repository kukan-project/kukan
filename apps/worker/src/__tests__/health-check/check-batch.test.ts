import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkBatch } from '../../health-check/check-batch'
import * as headRequest from '../../health-check/head-request'
import type { HeadCheckResult } from '../../health-check/types'

// Mock executeHeadCheck
vi.mock('../../health-check/head-request', () => ({
  executeHeadCheck: vi.fn(),
}))

// Mock config
vi.mock('@/config', () => ({
  HEALTH_CHECK_BATCH_SIZE: 200,
  HEALTH_CHECK_CONCURRENCY: 10,
  HEALTH_CHECK_TIMEOUT_MS: 10_000,
}))

function makeHeadResult(overrides: Partial<HeadCheckResult> = {}): HeadCheckResult {
  return {
    httpStatus: 200,
    healthStatus: 'ok',
    etag: '"v1"',
    lastModified: null,
    changed: false,
    errorMessage: null,
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

  return db
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
        extras: {},
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
        extras: { healthEtag: '"v1"' },
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

  it('enqueues no-header resources for periodic full fetch', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'https://example.com/data.csv',
        hash: null,
        healthStatus: 'ok',
        healthCheckedAt: new Date(),
        extras: {},
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
        extras: { healthLastFullFetchAt: Date.now() },
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

  it('handles invalid URLs gracefully', async () => {
    const rows = [
      {
        id: 'res-1',
        url: 'not-a-valid-url',
        hash: null,
        healthStatus: 'unknown',
        healthCheckedAt: null,
        extras: {},
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
        extras: {},
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
        extras: {},
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
})
