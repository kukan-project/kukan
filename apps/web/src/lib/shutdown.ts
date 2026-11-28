import { setTimeout } from 'node:timers/promises'
import { createLogger } from '@kukan/shared'

const SHUTDOWN_TIMEOUT_MS = 5000

let stopping = false

/**
 * SIGTERM/SIGINT for the production server, which start.mjs takes from Next
 * (NEXT_MANUAL_SIG_HANDLE). Next's own handler does not wait for the app's
 * shutdown and ends with 143, which Lambda counts as Runtime.ExitError at every
 * spin-down. No request is in flight by now (ALB draining, Lambda's idle
 * spin-down); Next's after() would not be waited for either — the app does not
 * use it.
 */
export function handleShutdownSignals(): void {
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

async function stop() {
  if (stopping) return
  stopping = true
  await Promise.race([shutdown(), setTimeout(SHUTDOWN_TIMEOUT_MS)])
  process.exit(0)
}

async function shutdown() {
  try {
    const { closePool, flushAiUsage } = await import('@kukan/api')
    await flushAiUsage()
    await closePool()
  } catch (err) {
    createLogger({ name: 'web' }).error({ err }, 'Shutdown failed')
  }
}
