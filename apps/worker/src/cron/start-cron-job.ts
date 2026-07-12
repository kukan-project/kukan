/**
 * Shared cron job starter.
 * Uses croner with protect:true to prevent overlapping runs.
 */

import { Cron } from 'croner'
import type { Logger } from '@kukan/shared'

export interface StartCronJobOptions {
  name: string
  cronExpression: string
  log: Logger
  meta?: Record<string, unknown>
  run: () => Promise<void>
}

/**
 * Start a protected cron job. Failures are logged, never thrown.
 * Returns the Cron instance for shutdown management.
 */
export function startCronJob(options: StartCronJobOptions): Cron {
  const { name, cronExpression, log, meta, run } = options

  const job = new Cron(cronExpression, { protect: true }, async () => {
    try {
      await run()
    } catch (err) {
      log.error({ err }, `${name} batch failed`)
    }
  })

  log.info({ cron: cronExpression, ...meta }, `${name} scheduler started`)

  return job
}
