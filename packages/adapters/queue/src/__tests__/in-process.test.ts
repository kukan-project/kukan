import { describe, it, expect, afterEach, vi } from 'vitest'
import { InProcessQueueAdapter } from '../in-process'

describe('InProcessQueueAdapter', () => {
  let queue: InProcessQueueAdapter

  afterEach(async () => {
    await queue?.stop()
  })

  describe('enqueue', () => {
    it('should return a job ID', async () => {
      queue = new InProcessQueueAdapter()
      const id = await queue.enqueue('test', { value: 1 })
      expect(id).toBeDefined()
      expect(typeof id).toBe('string')
    })

    it('should store job with pending status', async () => {
      queue = new InProcessQueueAdapter()
      const id = await queue.enqueue('test', { value: 1 })
      const status = await queue.getStatus(id)
      expect(status).not.toBeNull()
      expect(status!.status).toBe('pending')
    })
  })

  describe('getStatus', () => {
    it('should return null for unknown job ID', async () => {
      queue = new InProcessQueueAdapter()
      const status = await queue.getStatus('nonexistent')
      expect(status).toBeNull()
    })

    it('should return status for known job', async () => {
      queue = new InProcessQueueAdapter()
      const id = await queue.enqueue('test', {})
      const status = await queue.getStatus(id)
      expect(status).toEqual({
        id,
        status: 'pending',
        error: undefined,
      })
    })
  })

  describe('process + enqueue', () => {
    it('should process pending jobs with registered handler', async () => {
      queue = new InProcessQueueAdapter()
      const processed: unknown[] = []

      await queue.process('test', async (job) => {
        processed.push(job.data)
      })

      const id = await queue.enqueue('test', { value: 42 })

      // Wait for processing (triggered immediately for registered handler)
      await vi.waitFor(async () => {
        const status = await queue.getStatus(id)
        expect(status!.status).toBe('completed')
      })

      expect(processed).toEqual([{ value: 42 }])
    })

    it('should set status to completed on success', async () => {
      queue = new InProcessQueueAdapter()
      await queue.process('test', async () => {})

      const id = await queue.enqueue('test', {})

      await vi.waitFor(async () => {
        const status = await queue.getStatus(id)
        expect(status!.status).toBe('completed')
      })
    })

    it('should set status to failed on handler error', async () => {
      queue = new InProcessQueueAdapter()
      await queue.process('test', async () => {
        throw new Error('handler failed')
      })

      const id = await queue.enqueue('test', {})

      await vi.waitFor(async () => {
        const status = await queue.getStatus(id)
        expect(status!.status).toBe('failed')
      })

      const status = await queue.getStatus(id)
      expect(status!.error).toBe('handler failed')
    })

    it('should not process jobs without a registered handler', async () => {
      queue = new InProcessQueueAdapter()
      const id = await queue.enqueue('unhandled', {})

      // Give some time
      await new Promise((r) => setTimeout(r, 50))
      const status = await queue.getStatus(id)
      expect(status!.status).toBe('pending')
    })
  })

  describe('stop', () => {
    it('should stop processing interval', async () => {
      queue = new InProcessQueueAdapter()
      await queue.process('test', async () => {})
      await queue.stop()

      // Enqueue after stop — should remain pending
      const id = await queue.enqueue('test', {})
      await new Promise((r) => setTimeout(r, 50))
      const status = await queue.getStatus(id)
      expect(status!.status).toBe('pending')
    })
  })
})
