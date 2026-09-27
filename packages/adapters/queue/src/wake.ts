/**
 * The worker's wake signal (ADR-058 §3).
 *
 * An empty POST that says "look at the job table". It carries nothing, so all
 * a forged one can do is wake the database — still not something to leave
 * open. The token is derived from the auth secret both processes already have,
 * so there is no second secret to provision and rotate.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { lookup } from 'dns/promises'

const WAKE_TIMEOUT_MS = 2_000

/** The `Authorization` header a wake carries. */
export function wakeAuthorization(authSecret: string): string {
  const token = createHmac('sha256', authSecret).update('kukan-worker-wake').digest('hex')
  return `Bearer ${token}`
}

/** Whether an `Authorization` header carries the token. */
export function isWakeAuthorized(header: string | undefined, authSecret: string): boolean {
  const expected = Buffer.from(wakeAuthorization(authSecret))
  const given = Buffer.from(header ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * A `notify` for `PostgresQueueAdapter` that POSTs to every worker task.
 *
 * Every address the name resolves to, not the first: a worker takes one job
 * at a time, so a signal that lands on a task busy with a long one waits for
 * that job to end while another task sits idle (ADR-058 §3). The idle ones
 * take the job; the busy ones note a pass to make once they are free, and
 * SKIP LOCKED keeps two from taking the same row. Fails only when no task
 * answered.
 */
export function httpWake(url: string, authSecret: string): () => Promise<void> {
  const authorization = wakeAuthorization(authSecret)
  const target = new URL(url)
  return async () => {
    const addresses = await lookup(target.hostname, { all: true })
    const results = await Promise.allSettled(
      addresses.map(async ({ address, family }) => {
        const each = new URL(target)
        each.hostname = family === 6 ? `[${address}]` : address
        const res = await fetch(each, {
          method: 'POST',
          headers: { authorization },
          signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`Worker wake answered ${res.status}`)
      })
    )
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length === results.length) {
      throw failed[0]?.reason ?? new Error(`${target.hostname} resolved to no address`)
    }
  }
}
