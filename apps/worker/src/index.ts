/**
 * KUKAN Worker — SQS Queue Consumer
 * Processes resource pipeline jobs from the SQS queue.
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import { loadEnv, PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { Job } from '@kukan/queue-adapter'
import { createDb, runMigrations } from '@kukan/db'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { processResource } from './pipeline/process-resource'
import { buildPipelineContext } from './pipeline/build-context'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const env = loadEnv()

// Initialize database (worker processes jobs sequentially, so fewer connections needed)
const db = createDb(env.DATABASE_URL, {
  max: env.WORKER_DB_POOL_MAX,
  idleTimeoutMillis: env.WORKER_DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.WORKER_DB_POOL_CONNECTION_TIMEOUT_MS,
})

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

// --- Health check HTTP server (for ECS Fargate health monitoring) ---
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080', 10)
const STALE_THRESHOLD_MS = 60_000 // 60 seconds
let ready = false

const health = new Hono()
health.get('/health', (c) => {
  // During migration/startup, return 200 to keep ECS happy
  if (!ready) {
    return c.json({ status: 'starting' })
  }

  const { lastPollAt, processingJobSince } = queue
  const now = Date.now()

  // Healthy if actively processing a job OR last poll was recent
  const isProcessing = processingJobSince !== null
  const isPollingHealthy = lastPollAt !== null && now - lastPollAt.getTime() < STALE_THRESHOLD_MS

  if (isProcessing || isPollingHealthy) {
    return c.json({
      status: 'ok',
      lastPollAt: lastPollAt?.toISOString() ?? null,
      processingJobSince: processingJobSince?.toISOString() ?? null,
    })
  }
  return c.json(
    {
      status: 'unhealthy',
      lastPollAt: lastPollAt?.toISOString() ?? null,
      processingJobSince: null,
    },
    503
  )
})

serve({ fetch: health.fetch, port: HEALTH_PORT })

// --- Run DB migrations before starting ---
await runMigrations(env.DATABASE_URL)
ready = true

// --- SQS polling ---
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
console.log(`  Health: http://localhost:${HEALTH_PORT}/health`)

// Graceful shutdown
const shutdown = async () => {
  console.log('[Worker] Shutting down...')
  await queue.stop()
  await db.$client.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
