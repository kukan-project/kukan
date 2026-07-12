import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '@kukan/shared'

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

import { startCronJob } from '../../cron/start-cron-job'

function makeLog() {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger
}

const mockLog = makeLog()

describe('startCronJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cronCallback = null
  })

  it('should create a Cron job and return it', () => {
    const job = startCronJob({
      name: 'Health check',
      cronExpression: '*/5 * * * *',
      log: mockLog,
      run: vi.fn(),
    })

    expect(job).toBe(mockCronInstance)
  })

  it('should pass cronExpression and protect option to Cron', async () => {
    const { Cron } = await import('croner')
    const MockedCron = vi.mocked(Cron)

    startCronJob({
      name: 'Health check',
      cronExpression: '0 */2 * * *',
      log: mockLog,
      run: vi.fn(),
    })

    expect(MockedCron).toHaveBeenCalledWith('0 */2 * * *', { protect: true }, expect.any(Function))
  })

  it('should call run when cron fires', async () => {
    const run = vi.fn().mockResolvedValue(undefined)

    startCronJob({
      name: 'Health check',
      cronExpression: '*/5 * * * *',
      log: mockLog,
      run,
    })

    expect(cronCallback).toBeDefined()
    await cronCallback!()

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('should catch and log errors from run', async () => {
    const log = makeLog()
    const run = vi.fn().mockRejectedValue(new Error('batch failed'))

    startCronJob({
      name: 'Nightly job',
      cronExpression: '*/5 * * * *',
      log,
      run,
    })

    // Should not throw
    await expect(cronCallback!()).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Nightly job batch failed')
  })

  it('should log startup with cron expression and meta', () => {
    const log = makeLog()

    startCronJob({
      name: 'Health check',
      cronExpression: '*/5 * * * *',
      log,
      meta: { stalenessHours: 24 },
      run: vi.fn(),
    })

    expect(log.info).toHaveBeenCalledWith(
      { cron: '*/5 * * * *', stalenessHours: 24 },
      'Health check scheduler started'
    )
  })
})
