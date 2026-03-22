/**
 * KUKAN Worker — SQS Queue Consumer
 * Processes resource pipeline jobs from the SQS queue.
 */

import { config } from 'dotenv'
import { loadEnv, PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { Job } from '@kukan/queue-adapter'
import { createDb } from '@kukan/db'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { processResource } from './pipeline/process-resource'
import { buildPipelineContext } from './pipeline/build-context'

// Load .env file from project root
config({ path: '../../.env' })

const env = loadEnv()

// Initialize database
const db = createDb(env.DATABASE_URL)

// Initialize storage adapter (S3: AWS S3 or MinIO)
const storage = new S3StorageAdapter({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
})

// Initialize SQS queue adapter
const queue = new SQSQueueAdapter({
  region: env.SQS_REGION,
  queueUrl: env.SQS_QUEUE_URL,
  endpoint: env.SQS_ENDPOINT,
  accessKeyId: env.SQS_ACCESS_KEY,
  secretAccessKey: env.SQS_SECRET_KEY,
})

// Register pipeline handler
const ctx = buildPipelineContext(db, storage)
await queue.process<{ resourceId: string }>(
  PIPELINE_JOB_TYPE,
  async (job: Job<{ resourceId: string }>) => {
    console.log(`[Worker] Processing job ${job.id} for resource ${job.data.resourceId}`)
    await processResource(job.data.resourceId, ctx, db)
    console.log(`[Worker] Completed job ${job.id}`)
  }
)

console.log(`KUKAN Worker started`)
console.log(`  Queue: ${env.SQS_QUEUE_URL}`)

// Graceful shutdown
const shutdown = async () => {
  console.log('[Worker] Shutting down...')
  await queue.stop()
  await db.$client.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
