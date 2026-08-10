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
import { createLogger, type Logger } from '@kukan/shared'
import type { EnqueueOptions, Job, QueueAdapter, QueueStats } from './adapter'

export interface SQSConfig {
  region: string
  queueUrl: string
  endpoint?: string // ElasticMQ: 'http://localhost:9324', AWS SQS: omit
  accessKeyId?: string
  secretAccessKey?: string
  logger?: Logger
}

export class SQSQueueAdapter implements QueueAdapter {
  private client: SQSClient
  private queueUrl: string
  private log: Logger
  private running = false
  private pollPromise?: Promise<void>
  private abortController?: AbortController

  /** Timestamp of the last successful SQS poll (for health monitoring) */
  lastPollAt: Date | null = null

  /** Timestamp when the current job started processing (null if idle) */
  processingJobSince: Date | null = null

  constructor(config: SQSConfig) {
    this.queueUrl = config.queueUrl
    this.log = config.logger ?? createLogger({ name: 'sqs-queue' })
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

  async enqueue<T>(type: string, data: T, options?: EnqueueOptions): Promise<string> {
    const jobId = randomUUID()
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type, data }),
        MessageAttributes: {
          JobId: { DataType: 'String', StringValue: jobId },
        },
        ...(options?.delaySeconds != null && { DelaySeconds: options.delaySeconds }),
      })
    )
    return jobId
  }

  async getStats(): Promise<QueueStats> {
    const attrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      })
    )

    return {
      pending: Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(attrs.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
    }
  }

  async process(handlers: Record<string, (job: Job<unknown>) => Promise<void>>): Promise<void> {
    if (this.running) throw new Error('SQSQueueAdapter.process() already running')
    this.running = true
    this.abortController = new AbortController()
    this.pollPromise = this.pollLoop(handlers)
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    if (this.pollPromise) {
      await this.pollPromise
      this.pollPromise = undefined
    }
  }

  private async pollLoop(
    handlers: Record<string, (job: Job<unknown>) => Promise<void>>
  ): Promise<void> {
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
          let body: { type: string; data: unknown }
          try {
            body = JSON.parse(message.Body!) as { type: string; data: unknown }
          } catch {
            this.log.error({ messageId: message.MessageId }, 'Invalid message body, deleting')
            await this.deleteMessage(message.ReceiptHandle!)
            continue
          }

          const handler = handlers[body.type]
          if (!handler) {
            this.log.warn(
              { type: body.type, messageId: message.MessageId },
              'Unknown job type, deleting'
            )
            await this.deleteMessage(message.ReceiptHandle!)
            continue
          }

          const jobId = message.MessageAttributes?.JobId?.StringValue ?? randomUUID()
          const job: Job<unknown> = { id: jobId, type: body.type, data: body.data }

          try {
            this.processingJobSince = new Date()
            await handler(job)
            this.processingJobSince = null
            await this.deleteMessage(message.ReceiptHandle!)
          } catch (err) {
            this.processingJobSince = null
            // Message returns to queue after visibility timeout. Payload
            // included: some handlers log nothing of their own before throwing,
            // leaving this as the only record of which job it was.
            this.log.error({ err, jobId, type: job.type, data: job.data }, 'Handler error')
          }
        }
      } catch (err) {
        if (!this.running) break
        this.log.error({ err }, 'Poll error')
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
