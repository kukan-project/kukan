/**
 * Health check scheduler.
 * Uses croner with protect:true to prevent overlapping runs.
 */

import { Cron } from 'croner'
import type { Database } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { Logger } from '@kukan/shared'
import { checkBatch } from './check-batch'

export interface SchedulerOptions {
  db: Database
  queue: QueueAdapter
  cronExpression: string
  stalenessHours: number
  fullFetchIntervalHours: number
  log: Logger
}

/**
 * Start the health check scheduler.
 * Returns the Cron instance for shutdown management.
 */
export function startHealthCheckScheduler(options: SchedulerOptions): Cron {
  const { db, queue, cronExpression, stalenessHours, fullFetchIntervalHours, log } = options

  const job = new Cron(cronExpression, { protect: true }, async () => {
    try {
      await checkBatch(db, queue, stalenessHours, fullFetchIntervalHours, log)
    } catch (err) {
      log.error({ err }, 'Health check batch failed')
    }
  })

  log.info(
    { cron: cronExpression, stalenessHours, fullFetchIntervalHours },
    'Health check scheduler started'
  )

  return job
}
