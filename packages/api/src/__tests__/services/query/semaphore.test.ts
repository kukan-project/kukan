import { describe, it, expect } from 'vitest'
import { Semaphore } from '../../../services/query/semaphore'

describe('Semaphore', () => {
  it('grants up to max slots then refuses', () => {
    const sem = new Semaphore(2)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(false)
    expect(sem.inUse).toBe(2)
  })

  it('frees a slot on release', () => {
    const sem = new Semaphore(1)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(false)
    sem.release()
    expect(sem.inUse).toBe(0)
    expect(sem.tryAcquire()).toBe(true)
  })

  it('does not underflow when over-released', () => {
    const sem = new Semaphore(1)
    sem.release()
    sem.release()
    expect(sem.inUse).toBe(0)
  })
})
