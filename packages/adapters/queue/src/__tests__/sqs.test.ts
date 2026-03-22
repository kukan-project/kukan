import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQSQueueAdapter } from '../sqs'

// Mock @aws-sdk/client-sqs
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ input, _type: 'Send' })),
  ReceiveMessageCommand: vi.fn().mockImplementation((input) => ({ input, _type: 'Receive' })),
  DeleteMessageCommand: vi.fn().mockImplementation((input) => ({ input, _type: 'Delete' })),
}))

describe('SQSQueueAdapter', () => {
  let queue: SQSQueueAdapter

  beforeEach(() => {
    mockSend.mockReset()
    queue = new SQSQueueAdapter({
      region: 'ap-northeast-1',
      queueUrl: 'http://localhost:9324/000000000000/test-queue',
      endpoint: 'http://localhost:9324',
      accessKeyId: 'x',
      secretAccessKey: 'x',
    })
  })

  describe('enqueue', () => {
    it('should send message to SQS and return job ID', async () => {
      mockSend.mockResolvedValue({})

      const jobId = await queue.enqueue('resource-pipeline', { resourceId: 'r1' })

      expect(jobId).toBeDefined()
      expect(typeof jobId).toBe('string')
      expect(mockSend).toHaveBeenCalledTimes(1)

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.QueueUrl).toBe('http://localhost:9324/000000000000/test-queue')

      const body = JSON.parse(cmd.input.MessageBody)
      expect(body.type).toBe('resource-pipeline')
      expect(body.data).toEqual({ resourceId: 'r1' })
    })

    it('should include job ID in message attributes', async () => {
      mockSend.mockResolvedValue({})

      const jobId = await queue.enqueue('test', {})

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.MessageAttributes.JobId.StringValue).toBe(jobId)
    })
  })

  describe('getStatus', () => {
    it('should always return null', async () => {
      const status = await queue.getStatus('any-id')
      expect(status).toBeNull()
    })
  })

  describe('process + stop', () => {
    it('should poll messages and call handler', async () => {
      const processed: unknown[] = []

      // First call: return a message. Second call: hang until stop.
      mockSend
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: 'msg-1',
              Body: JSON.stringify({ type: 'test', data: { value: 42 } }),
              ReceiptHandle: 'rh-1',
              MessageAttributes: {
                JobId: { StringValue: 'job-1', DataType: 'String' },
              },
            },
          ],
        })
        // DeleteMessage response
        .mockResolvedValueOnce({})
        // Second poll: empty, then stop
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ Messages: [] }), 50)
            })
        )

      await queue.process<{ value: number }>('test', async (job) => {
        processed.push(job)
      })

      // Wait for processing
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      expect(processed).toHaveLength(1)
      expect(processed[0]).toEqual({
        id: 'job-1',
        type: 'test',
        data: { value: 42 },
      })
    })

    it('should delete message after successful processing', async () => {
      mockSend
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: 'msg-1',
              Body: JSON.stringify({ type: 'test', data: {} }),
              ReceiptHandle: 'rh-1',
              MessageAttributes: {},
            },
          ],
        })
        .mockResolvedValueOnce({}) // DeleteMessage
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ Messages: [] }), 50)
            })
        )

      await queue.process('test', async () => {})
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      // Second call should be DeleteMessage
      const deleteCmd = mockSend.mock.calls[1][0]
      expect(deleteCmd.input.ReceiptHandle).toBe('rh-1')
    })

    it('should not delete message on handler error', async () => {
      mockSend
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: 'msg-1',
              Body: JSON.stringify({ type: 'test', data: {} }),
              ReceiptHandle: 'rh-1',
              MessageAttributes: {},
            },
          ],
        })
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ Messages: [] }), 50)
            })
        )

      // Suppress console.error for expected error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await queue.process('test', async () => {
        throw new Error('handler failed')
      })
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      consoleSpy.mockRestore()

      // Only ReceiveMessage, no DeleteMessage after the failed handler
      const callTypes = mockSend.mock.calls.map((c) => c[0]._type)
      expect(callTypes).not.toContain('Delete')
    })

    it('should stop polling when stop() is called', async () => {
      mockSend.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ Messages: [] }), 50)
          })
      )

      await queue.process('test', async () => {})
      await queue.stop()

      // After stop, no more send calls should happen
      const callCount = mockSend.mock.calls.length
      await new Promise((r) => setTimeout(r, 200))
      expect(mockSend.mock.calls.length).toBe(callCount)
    })
  })
})
