/**
 * KUKAN SQS Queue Adapter
 * Works with both AWS SQS (production) and ElasticMQ (development).
 */

import { randomUUID } from 'crypto'
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs'
import type { Job, JobStatus, QueueAdapter, QueueStats } from './adapter'

export interface SQSConfig {
  region: string
  queueUrl: string
  endpoint?: string // ElasticMQ: 'http://localhost:9324', AWS SQS: omit
  accessKeyId?: string
  secretAccessKey?: string
  dlqUrl?: string // Dead letter queue URL (for stats)
}

export class SQSQueueAdapter implements QueueAdapter {
  private client: SQSClient
  private queueUrl: string
  private dlqUrl?: string
  private running = false
  private pollPromise?: Promise<void>
  private abortController?: AbortController

  /** Timestamp of the last successful SQS poll (for health monitoring) */
  lastPollAt: Date | null = null

  /** Timestamp when the current job started processing (null if idle) */
  processingJobSince: Date | null = null

  constructor(config: SQSConfig) {
    this.queueUrl = config.queueUrl
    this.dlqUrl = config.dlqUrl
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint && { endpoint: config.endpoint }),
      ...(config.accessKeyId &&
        config.secretAccessKey && {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
    })
  }

  async enqueue<T>(type: string, data: T): Promise<string> {
    const jobId = randomUUID()
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type, data }),
        MessageAttributes: {
          JobId: { DataType: 'String', StringValue: jobId },
        },
      })
    )
    return jobId
  }

  async getStatus(_jobId: string): Promise<JobStatus | null> {
    // SQS does not track individual job status.
    // Pipeline status is managed via the resource_pipeline DB table.
    return null
  }

  async getStats(): Promise<QueueStats> {
    const mainPromise = this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      })
    )

    const dlqPromise = this.dlqUrl
      ? this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.dlqUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          })
        )
      : null

    const [attrs, dlqAttrs] = await Promise.all([mainPromise, dlqPromise])

    return {
      pending: Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(attrs.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
      dlqPending: dlqAttrs ? Number(dlqAttrs.Attributes?.ApproximateNumberOfMessages ?? 0) : 0,
    }
  }

  async process<T>(type: string, handler: (job: Job<T>) => Promise<void>): Promise<void> {
    if (this.running) throw new Error('SQSQueueAdapter.process() already running')
    this.running = true
    this.abortController = new AbortController()
    this.pollPromise = this.pollLoop(type, handler)
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    if (this.pollPromise) {
      await this.pollPromise
      this.pollPromise = undefined
    }
  }

  private async pollLoop<T>(type: string, handler: (job: Job<T>) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abortController?.signal }
        )

        this.lastPollAt = new Date()

        if (!response.Messages?.length) continue

        for (const message of response.Messages) {
          let body: { type: string; data: T }
          try {
            body = JSON.parse(message.Body!) as { type: string; data: T }
          } catch {
            console.error('[SQSQueue] Invalid message body, deleting:', message.MessageId)
            await this.deleteMessage(message.ReceiptHandle!)
            continue
          }

          if (body.type !== type) {
            console.warn(`[SQSQueue] Unknown type "${body.type}", deleting:`, message.MessageId)
            await this.deleteMessage(message.ReceiptHandle!)
            continue
          }

          const jobId = message.MessageAttributes?.JobId?.StringValue ?? randomUUID()
          const job: Job<T> = { id: jobId, type: body.type, data: body.data }

          try {
            this.processingJobSince = new Date()
            await handler(job)
            this.processingJobSince = null
            await this.deleteMessage(message.ReceiptHandle!)
          } catch (err) {
            this.processingJobSince = null
            // Message returns to queue after visibility timeout
            console.error(`[SQSQueue] Handler error for job ${jobId}:`, err)
          }
        }
      } catch (err) {
        if (!this.running) break
        console.error('[SQSQueue] Poll error:', err)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle })
    )
  }
}
