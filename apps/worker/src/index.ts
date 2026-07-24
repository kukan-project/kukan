/**
 * KUKAN Worker — SQS Queue Consumer
 * Processes resource pipeline jobs from the SQS queue.
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import {
  loadEnv,
  createLogger,
  PIPELINE_JOB_TYPE,
  REINDEX_JOB_TYPE,
  PURGE_ORG_JOB_TYPE,
  PURGE_VERSION_JOB_TYPE,
  EMBED_JOB_TYPE,
  pipelineJobSchema,
  reindexJobSchema,
  purgeOrgJobSchema,
  purgeVersionJobSchema,
  embedJobSchema,
} from '@kukan/shared'
import { eq, sql } from 'drizzle-orm'
import { packageTable } from '@kukan/db'
import type { Job } from '@kukan/queue-adapter'
import { rebuildMetadataIndex } from '@kukan/api/services/search-index'
import { PipelineService } from '@kukan/api/services/pipeline-service'
import { OrganizationService } from '@kukan/api/services/organization-service'
import { ResourceVersionService } from '@kukan/api/services/resource-version-service'
import { createAIAdapter } from '@kukan/api/adapters'
import { createDb, runMigrations } from '@kukan/db'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { OpenSearchAdapter } from '@kukan/search-adapter'
import { processResource } from './pipeline/process-resource'
import { buildPipelineContext } from './pipeline/build-context'
import { startCronJob } from './cron/start-cron-job'
import { checkBatch } from './cron/health-check/check-batch'
import { embedPackage, enqueueAllPackageEmbeds } from './embed/embed-package'

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
  const hcLog = log.child({ component: 'health-check' })
  const stalenessHours = env.HEALTH_CHECK_STALENESS_HOURS
  const fullFetchIntervalHours = env.HEALTH_CHECK_FULL_FETCH_INTERVAL_HOURS
  healthCheckJob = startCronJob({
    name: 'Health check',
    cronExpression: env.HEALTH_CHECK_CRON,
    log: hcLog,
    meta: { stalenessHours, fullFetchIntervalHours },
    run: async () => {
      await checkBatch(db, queue, stalenessHours, fullFetchIntervalHours, hcLog)
    },
  })
}

// --- Search adapter (optional, for content indexing) ---
const osLogger = log.child({ component: 'opensearch' })
const search =
  env.SEARCH_TYPE === 'opensearch'
    ? new OpenSearchAdapter({
        endpoint: env.OPENSEARCH_URL,
        indexPrefix: env.OPENSEARCH_INDEX_PREFIX,
        replicas: env.OPENSEARCH_REPLICAS,
        logger: osLogger,
      })
    : undefined

// --- AI adapter (embedding; NoOp when AI_TYPE=none) ---
const ai = createAIAdapter(env)
const embeddingEnabled = ai.getEmbeddingInfo() !== null

// Validate a job payload against its schema; logs and returns null on mismatch so
// the handler can bail without ever trusting an unvalidated SQS message body.
function parseJobPayload<T>(
  job: Job,
  schema: {
    safeParse(
      data: unknown
    ): { success: true; data: T } | { success: false; error: { message: string } }
  }
): T | null {
  const parsed = schema.safeParse(job.data ?? {})
  if (parsed.success) return parsed.data
  log.error({ jobId: job.id, type: job.type, err: parsed.error.message }, 'Invalid job payload')
  return null
}

// --- SQS polling ---
const ctx = buildPipelineContext(db, storage, search)
await queue.process({
  // Pipeline (data-plane): process one resource.
  [PIPELINE_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, pipelineJobSchema)
    if (!data) return
    const { resourceId } = data
    log.info({ jobId: job.id, type: job.type, resourceId }, 'Processing job')
    const start = performance.now()
    await processResource(resourceId, ctx, db, queue)
    const elapsed = Math.round(performance.now() - start)
    log.info({ jobId: job.id, type: job.type, resourceId, elapsed }, 'Completed job')
  },
  // Maintenance (control-plane): rebuild the search index.
  [REINDEX_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, reindexJobSchema)
    if (!data) return
    const { includeContent } = data
    log.info({ jobId: job.id, type: job.type, includeContent }, 'Reindex metadata job started')
    const start = performance.now()
    if (search) {
      const jobLogger = osLogger.child({ jobId: job.id, type: job.type })
      await rebuildMetadataIndex(db, search, jobLogger, true)
      if (includeContent) {
        await search.deleteAllContents()
        const pipelineService = new PipelineService(db, queue)
        const { enqueued, failed } = await pipelineService.enqueueAll()
        log.info(
          { jobId: job.id, type: job.type, enqueued, failed },
          'Content pipeline jobs enqueued'
        )
      }
      const elapsed = Math.round(performance.now() - start)
      log.info({ jobId: job.id, type: job.type, elapsed }, 'Reindex metadata job completed')
    } else {
      log.warn({ jobId: job.id, type: job.type }, 'Reindex skipped — OpenSearch not configured')
    }
    // Re-enqueue embeddings for all packages regardless of search backend —
    // the per-package hash check skips unchanged ones cheaply.
    if (embeddingEnabled) {
      const { enqueued, failed } = await enqueueAllPackageEmbeds(db, queue, log)
      log.info({ jobId: job.id, type: job.type, enqueued, failed }, 'Embed jobs enqueued')
    }
  },
  // Semantic search: (re)generate the embedding vector for one package.
  [EMBED_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, embedJobSchema)
    if (!data) return
    const { packageId } = data
    const start = performance.now()
    const result = await embedPackage(packageId, db, ai, log)
    const elapsed = Math.round(performance.now() - start)
    log.info({ jobId: job.id, type: job.type, packageId, result, elapsed }, 'Embed job finished')
  },
  // Maintenance (control-plane): erase a soft-deleted org. Runs the destructive
  // work in the worker (retried on failure) — see OrganizationService.purgeDeletedOrg.
  [PURGE_ORG_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, purgeOrgJobSchema)
    if (!data) return
    const { organizationId } = data
    log.info({ jobId: job.id, type: job.type, organizationId }, 'Purge organization job started')
    const start = performance.now()
    const orgService = new OrganizationService(db)
    const { purged, packageCount } = await orgService.purgeDeletedOrg(organizationId, {
      search,
      storage,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, organizationId, purged, packageCount, elapsed },
      purged ? 'Purge organization job completed' : 'Purge organization job skipped (not deleted)'
    )
  },
  // Legal deletion: destroy one resource version's content (ADR-043). Rolls the
  // live version back to the previous one when the purged version was live.
  [PURGE_VERSION_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, purgeVersionJobSchema)
    if (!data) return
    const { resourceId, version } = data
    log.info({ jobId: job.id, type: job.type, resourceId, version }, 'Purge version job started')
    const start = performance.now()
    const result = await new ResourceVersionService(db).executePurge(resourceId, version, {
      storage,
      search,
      queue,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, resourceId, version, ...result, elapsed },
      result.purged ? 'Purge version job completed' : 'Purge version job skipped (not purging)'
    )
  },
})

// --- Periodic index health check (detect data loss even when queue is idle) ---
const INDEX_CHECK_INTERVAL_MS = 60_000
const REBUILD_COOLDOWN_MS = 5 * 60 * 1000
let lastRebuildEnqueuedAt = 0
let indexCheckTimer: ReturnType<typeof setInterval> | undefined
if (search) {
  indexCheckTimer = setInterval(async () => {
    try {
      const osCount = await search.getPackagesDocCount()
      if (osCount !== 0) return // Non-empty or error — no action needed

      // OS index is empty — check DB to confirm data loss (avoid Aurora wake for normal state)
      const [{ count: dbCount }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(packageTable)
        .where(eq(packageTable.state, 'active'))

      if (dbCount > 0 && Date.now() - lastRebuildEnqueuedAt > REBUILD_COOLDOWN_MS) {
        osLogger.warn({ dbCount, osCount }, 'Index out of sync — enqueuing auto-recovery')
        lastRebuildEnqueuedAt = Date.now()
        await queue.enqueue(REINDEX_JOB_TYPE, { includeContent: true })
      }
    } catch (err) {
      osLogger.error({ err }, 'Periodic index check failed')
    }
  }, INDEX_CHECK_INTERVAL_MS)
}

log.info({ queueUrl: env.SQS_QUEUE_URL, healthPort: HEALTH_PORT }, 'Worker started')

// Graceful shutdown
const shutdown = async () => {
  log.info('Shutting down...')
  healthCheckJob?.stop()
  if (indexCheckTimer) clearInterval(indexCheckTimer)
  await queue.stop()
  await db.$client.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
