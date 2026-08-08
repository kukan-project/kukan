import { describe, it, expect, vi } from 'vitest'
import { RequestAbandonedError, TooManyRequestsError } from '@kukan/shared'
import { Semaphore } from '../../../services/query/semaphore'

/** Let queued microtasks (a resolved waiter) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Semaphore', () => {
  it('grants up to max slots', async () => {
    const sem = new Semaphore(2, 4, 1000)
    await sem.acquire()
    await sem.acquire()
    expect(sem.inUse).toBe(2)
  })

  it('makes the next caller wait instead of refusing', async () => {
    const sem = new Semaphore(1, 4, 1000)
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
    const sem = new Semaphore(1, 4, 1000)
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
    const sem = new Semaphore(1, 1, 1000)
    await sem.acquire()
    const queued = sem.acquire()
    await tick()

    await expect(sem.acquire()).rejects.toBeInstanceOf(TooManyRequestsError)

    sem.release()
    await queued
  })

  it('refuses with 429 when the wait runs out', async () => {
    vi.useFakeTimers()
    try {
      const sem = new Semaphore(1, 4, 1000)
      await sem.acquire()
      const waiting = sem.acquire()
      const assertion = expect(waiting).rejects.toBeInstanceOf(TooManyRequestsError)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
      expect(sem.queued).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an abandoned waiter so the ones behind it move up', async () => {
    const sem = new Semaphore(1, 4, 1000)
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
    const sem = new Semaphore(1, 4, 1000)
    await expect(sem.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(RequestAbandonedError)
    expect(sem.inUse).toBe(0)
  })

  it('frees a slot on release', async () => {
    const sem = new Semaphore(1, 4, 1000)
    await sem.acquire()
    sem.release()
    expect(sem.inUse).toBe(0)
  })

  it('does not underflow when over-released', () => {
    const sem = new Semaphore(1, 4, 1000)
    sem.release()
    sem.release()
    expect(sem.inUse).toBe(0)
  })
})
