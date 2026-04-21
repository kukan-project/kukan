import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLogger } from '@kukan/shared'
import { SQSQueueAdapter } from '../sqs'

// Mock @aws-sdk/client-sqs
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(function () {
    return { send: mockSend }
  }),
  SendMessageCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'Send' }
  }),
  ReceiveMessageCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'Receive' }
  }),
  DeleteMessageCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'Delete' }
  }),
  GetQueueAttributesCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'GetQueueAttributes' }
  }),
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
      logger: createLogger({ name: 'test', level: 'silent' }),
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

    it('should set DelaySeconds when provided', async () => {
      mockSend.mockResolvedValue({})

      await queue.enqueue('test', { resourceId: 'r1' }, { delaySeconds: 5 })

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.DelaySeconds).toBe(5)
    })

    it('should set DelaySeconds to 0 when explicitly provided', async () => {
      mockSend.mockResolvedValue({})

      await queue.enqueue('test', { resourceId: 'r1' }, { delaySeconds: 0 })

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.DelaySeconds).toBe(0)
    })

    it('should not set DelaySeconds when not provided', async () => {
      mockSend.mockResolvedValue({})

      await queue.enqueue('test', { resourceId: 'r1' })

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.DelaySeconds).toBeUndefined()
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

      await queue.process('test', async () => {
        throw new Error('handler failed')
      })
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      // Only ReceiveMessage, no DeleteMessage after the failed handler
      const callTypes = mockSend.mock.calls.map((c) => c[0]._type)
      expect(callTypes).not.toContain('Delete')
    })

    it('should throw when process() is called twice', async () => {
      mockSend.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ Messages: [] }), 50)
          })
      )

      await queue.process('test', async () => {})

      await expect(queue.process('test', async () => {})).rejects.toThrow('already running')

      await queue.stop()
    })

    it('should delete and skip messages with invalid JSON body', async () => {
      mockSend
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: 'msg-bad',
              Body: 'not json',
              ReceiptHandle: 'rh-bad',
              MessageAttributes: {},
            },
          ],
        })
        .mockResolvedValueOnce({}) // DeleteMessage for bad body
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ Messages: [] }), 50)
            })
        )

      const handler = vi.fn()
      await queue.process('test', handler)
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      expect(handler).not.toHaveBeenCalled()
      const deleteCmd = mockSend.mock.calls[1][0]
      expect(deleteCmd._type).toBe('Delete')
      expect(deleteCmd.input.ReceiptHandle).toBe('rh-bad')
    })

    it('should delete and skip messages with wrong type', async () => {
      mockSend
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: 'msg-wrong',
              Body: JSON.stringify({ type: 'unknown-type', data: {} }),
              ReceiptHandle: 'rh-wrong',
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

      const handler = vi.fn()
      await queue.process('test', handler)
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      expect(handler).not.toHaveBeenCalled()
      const deleteCmd = mockSend.mock.calls[1][0]
      expect(deleteCmd._type).toBe('Delete')
    })

    it('should update lastPollAt after receiving messages', async () => {
      expect(queue.lastPollAt).toBeNull()

      mockSend.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ Messages: [] }), 50)
          })
      )

      await queue.process('test', async () => {})
      await new Promise((r) => setTimeout(r, 200))
      await queue.stop()

      expect(queue.lastPollAt).toBeInstanceOf(Date)
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

  describe('getStats', () => {
    it('should return queue statistics', async () => {
      mockSend.mockResolvedValueOnce({
        Attributes: {
          ApproximateNumberOfMessages: '5',
          ApproximateNumberOfMessagesNotVisible: '2',
          ApproximateNumberOfMessagesDelayed: '1',
        },
      })

      const stats = await queue.getStats()

      expect(stats).toEqual({
        pending: 5,
        inFlight: 2,
        delayed: 1,
      })
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should default to 0 when Attributes is undefined', async () => {
      mockSend.mockResolvedValueOnce({})

      const stats = await queue.getStats()

      expect(stats).toEqual({
        pending: 0,
        inFlight: 0,
        delayed: 0,
      })
    })

    it('should propagate SQS errors to the caller', async () => {
      mockSend.mockRejectedValueOnce(new Error('SQS unavailable'))

      await expect(queue.getStats()).rejects.toThrow('SQS unavailable')
    })
  })
})
