import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLogger } from '@kukan/shared'

// Capture the Cron callback
let cronCallback: (() => Promise<void>) | null = null
const mockCronInstance = { stop: vi.fn() }

vi.mock('croner', () => ({
  Cron: vi.fn().mockImplementation(function (
    _expr: string,
    _opts: unknown,
    cb: () => Promise<void>
  ) {
    cronCallback = cb
    return mockCronInstance
  }),
}))

const mockCheckBatch = vi.fn()
vi.mock('../health-check/check-batch', () => ({
  checkBatch: (...args: unknown[]) => mockCheckBatch(...args),
}))

import { startHealthCheckScheduler } from '../health-check/scheduler'

const mockLog = createLogger({ name: 'test', level: 'silent' })
const mockDb = {} as never
const mockQueue = {} as never

describe('startHealthCheckScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cronCallback = null
  })

  it('should create a Cron job and return it', () => {
    const job = startHealthCheckScheduler({
      db: mockDb,
      queue: mockQueue,
      cronExpression: '*/5 * * * *',
      stalenessHours: 24,
      fullFetchIntervalHours: 168,
      log: mockLog,
    })

    expect(job).toBe(mockCronInstance)
  })

  it('should pass cronExpression and protect option to Cron', async () => {
    const { Cron } = await import('croner')
    const MockedCron = vi.mocked(Cron)

    startHealthCheckScheduler({
      db: mockDb,
      queue: mockQueue,
      cronExpression: '0 */2 * * *',
      stalenessHours: 24,
      fullFetchIntervalHours: 168,
      log: mockLog,
    })

    expect(MockedCron).toHaveBeenCalledWith('0 */2 * * *', { protect: true }, expect.any(Function))
  })

  it('should call checkBatch when cron fires', async () => {
    mockCheckBatch.mockResolvedValue(undefined)

    startHealthCheckScheduler({
      db: mockDb,
      queue: mockQueue,
      cronExpression: '*/5 * * * *',
      stalenessHours: 12,
      fullFetchIntervalHours: 72,
      log: mockLog,
    })

    expect(cronCallback).toBeDefined()
    await cronCallback!()

    expect(mockCheckBatch).toHaveBeenCalledWith(mockDb, mockQueue, 12, 72, mockLog)
  })

  it('should catch and log errors from checkBatch', async () => {
    mockCheckBatch.mockRejectedValue(new Error('batch failed'))

    startHealthCheckScheduler({
      db: mockDb,
      queue: mockQueue,
      cronExpression: '*/5 * * * *',
      stalenessHours: 24,
      fullFetchIntervalHours: 168,
      log: mockLog,
    })

    // Should not throw
    await expect(cronCallback!()).resolves.toBeUndefined()
  })
})
