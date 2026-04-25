/**
 * KUKAN Worker — SQS Queue Consumer
 * Processes resource pipeline jobs from the SQS queue.
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import { loadEnv, createLogger, PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { Job } from '@kukan/queue-adapter'
import { createDb, runMigrations } from '@kukan/db'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { OpenSearchAdapter } from '@kukan/search-adapter'
import { processResource } from './pipeline/process-resource'
import { buildPipelineContext } from './pipeline/build-context'
import { startHealthCheckScheduler } from './health-check/scheduler'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const env = loadEnv()
const log = createLogger({ name: 'worker', level: env.LOG_LEVEL })

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
  logger: log.child({ component: 'sqs' }),
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

// --- Health check scheduler ---
let healthCheckJob: { stop: () => void } | null = null

if (env.HEALTH_CHECK_ENABLED) {
  healthCheckJob = startHealthCheckScheduler({
    db,
    queue,
    cronExpression: env.HEALTH_CHECK_CRON,
    stalenessHours: env.HEALTH_CHECK_STALENESS_HOURS,
    fullFetchIntervalHours: env.HEALTH_CHECK_FULL_FETCH_INTERVAL_HOURS,
    log: log.child({ component: 'health-check' }),
  })
}

// --- Search adapter (optional, for content indexing) ---
const search =
  env.SEARCH_TYPE === 'opensearch'
    ? new OpenSearchAdapter({
        endpoint: env.OPENSEARCH_URL,
        replicas: env.OPENSEARCH_REPLICAS,
        logger: log.child({ component: 'opensearch' }),
      })
    : undefined

// --- SQS polling ---
const ctx = buildPipelineContext(db, storage, search)
await queue.process<{ resourceId: string }>(
  PIPELINE_JOB_TYPE,
  async (job: Job<{ resourceId: string }>) => {
    log.info({ jobId: job.id, resourceId: job.data.resourceId }, 'Processing job')
    await processResource(job.data.resourceId, ctx, db, queue)
    log.info({ jobId: job.id, resourceId: job.data.resourceId }, 'Completed job')
  }
)

log.info({ queueUrl: env.SQS_QUEUE_URL, healthPort: HEALTH_PORT }, 'Worker started')

// Graceful shutdown
const shutdown = async () => {
  log.info('Shutting down...')
  healthCheckJob?.stop()
  await queue.stop()
  await db.$client.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
