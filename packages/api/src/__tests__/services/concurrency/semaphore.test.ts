import { describe, it, expect, vi } from 'vitest'
import { RequestAbandonedError, TooManyRequestsError } from '@kukan/shared'
import { Semaphore } from '../../../services/concurrency/semaphore'

const BUSY = { full: 'queue full', timedOut: 'waited too long', retryAfterSeconds: 3 }

/** Let queued microtasks (a resolved waiter) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Semaphore', () => {
  it('grants up to max slots', async () => {
    const sem = new Semaphore(2, 4, 1000, BUSY)
    await sem.acquire()
    await sem.acquire()
    expect(sem.inUse).toBe(2)
  })

  it('makes the next caller wait instead of refusing', async () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    await sem.acquire()

    let granted = false
    const waiting = sem.acquire().then(() => (granted = true))
    await tick()
    expect(granted).toBe(false)
    expect(sem.queued).toBe(1)

    sem.release()
    await waiting
    expect(granted).toBe(true)
    // The slot moved to the waiter rather than going idle
    expect(sem.inUse).toBe(1)
    expect(sem.queued).toBe(0)
  })

  it('hands slots to waiters in arrival order', async () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    await sem.acquire()

    const order: number[] = []
    const first = sem.acquire().then(() => order.push(1))
    const second = sem.acquire().then(() => order.push(2))
    await tick()

    sem.release()
    await first
    sem.release()
    await second
    expect(order).toEqual([1, 2])
  })

  it('refuses with 429 once the queue is full', async () => {
    const sem = new Semaphore(1, 1, 1000, BUSY)
    await sem.acquire()
    const queued = sem.acquire()
    await tick()

    const refused = await sem.acquire().catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(TooManyRequestsError)
    // In the caller's words: the feed's user is not told about queries.
    expect((refused as Error).message).toBe('queue full')
    // And with the pool's own Retry-After
    expect((refused as TooManyRequestsError).retryAfterSeconds).toBe(3)

    sem.release()
    await queued
  })

  it('refuses with 429 when the wait runs out', async () => {
    vi.useFakeTimers()
    try {
      const sem = new Semaphore(1, 4, 1000, BUSY)
      await sem.acquire()
      const waiting = sem.acquire()
      const refused = waiting.catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await refused).toBeInstanceOf(TooManyRequestsError)
      expect(((await refused) as Error).message).toBe('waited too long')
      expect(sem.queued).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an abandoned waiter so the ones behind it move up', async () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    await sem.acquire()

    const controller = new AbortController()
    const abandoned = sem.acquire(controller.signal)
    let grantedBehind = false
    const behind = sem.acquire().then(() => (grantedBehind = true))
    await tick()

    controller.abort()
    await expect(abandoned).rejects.toBeInstanceOf(RequestAbandonedError)
    expect(sem.queued).toBe(1)

    // The released slot goes to the caller behind, not to the one that left
    sem.release()
    await behind
    expect(grantedBehind).toBe(true)
  })

  it('refuses a caller that is already gone without taking a slot', async () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    await expect(sem.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(RequestAbandonedError)
    expect(sem.inUse).toBe(0)
  })

  it('frees a slot on release', async () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    await sem.acquire()
    sem.release()
    expect(sem.inUse).toBe(0)
  })

  it('does not underflow when over-released', () => {
    const sem = new Semaphore(1, 4, 1000, BUSY)
    sem.release()
    sem.release()
    expect(sem.inUse).toBe(0)
  })

  describe('priority', () => {
    const PRIORITISED = { priorities: true }

    it('hands a freed slot to a high-priority waiter ahead of earlier normal ones', async () => {
      const sem = new Semaphore(1, 4, 1000, BUSY, PRIORITISED)
      await sem.acquire()

      const order: string[] = []
      const normal1 = sem.acquire().then(() => order.push('normal1'))
      const normal2 = sem
        .acquire(undefined, { priority: 'normal' })
        .then(() => order.push('normal2'))
      const high = sem.acquire(undefined, { priority: 'high' }).then(() => order.push('high'))
      await tick()
      expect(sem.queued).toBe(3)

      sem.release()
      await high
      sem.release()
      await normal1
      sem.release()
      await normal2
      expect(order).toEqual(['high', 'normal1', 'normal2'])
    })

    it('keeps arrival order among high-priority waiters', async () => {
      const sem = new Semaphore(1, 4, 1000, BUSY, PRIORITISED)
      await sem.acquire()

      const order: number[] = []
      const first = sem.acquire(undefined, { priority: 'high' }).then(() => order.push(1))
      const second = sem.acquire(undefined, { priority: 'high' }).then(() => order.push(2))
      await tick()

      sem.release()
      await first
      sem.release()
      await second
      expect(order).toEqual([1, 2])
    })

    it('lets normal waiters take only half the queue, and high the rest of it', async () => {
      // maxWaiting 5: normal may hold ceil(5 / 2) = 3, high may fill to 5
      const sem = new Semaphore(1, 5, 1000, BUSY, PRIORITISED)
      await sem.acquire()

      const normals = [sem.acquire(), sem.acquire(), sem.acquire()]
      await tick()
      expect(sem.queued).toBe(3)

      const refused = await sem.acquire().catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(TooManyRequestsError)
      expect((refused as Error).message).toBe('queue full')

      // The queue is not full for a signed-in caller: two more go in
      const highs = [
        sem.acquire(undefined, { priority: 'high' }),
        sem.acquire(undefined, { priority: 'high' }),
      ]
      await tick()
      expect(sem.queued).toBe(5)

      // And at the queue's depth, high is refused too
      const overflow = await sem
        .acquire(undefined, { priority: 'high' })
        .catch((err: unknown) => err)
      expect(overflow).toBeInstanceOf(TooManyRequestsError)

      for (let i = 0; i < 5; i++) sem.release()
      await Promise.all([...highs, ...normals])
    })

    it('rounds the normal share up, so a queue of one still admits a normal waiter', async () => {
      const sem = new Semaphore(1, 1, 1000, BUSY, PRIORITISED)
      await sem.acquire()
      const queued = sem.acquire()
      await tick()
      expect(sem.queued).toBe(1)
      sem.release()
      await queued
    })

    it('drops an abandoned high-priority waiter like a normal one', async () => {
      const sem = new Semaphore(1, 4, 1000, BUSY, PRIORITISED)
      await sem.acquire()

      const controller = new AbortController()
      const abandoned = sem.acquire(controller.signal, { priority: 'high' })
      let grantedBehind = false
      const behind = sem.acquire().then(() => (grantedBehind = true))
      await tick()

      controller.abort()
      await expect(abandoned).rejects.toBeInstanceOf(RequestAbandonedError)
      expect(sem.queued).toBe(1)

      sem.release()
      await behind
      expect(grantedBehind).toBe(true)
    })
  })
})
