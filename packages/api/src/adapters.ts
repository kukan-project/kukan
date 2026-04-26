/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env, Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter, OpenSearchAdapter } from '@kukan/search-adapter'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'
import { rebuildMetadataIndex } from './services/search-index'
import { PipelineService } from './services/pipeline-service'

export async function createAdapters(env: Env, db: Database, logger: Logger) {
  // Storage adapter (S3: AWS S3 or MinIO, determined by S3_ENDPOINT)
  const storage = new S3StorageAdapter({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  })

  // Queue adapter (SQS-compatible: AWS SQS or ElasticMQ, determined by SQS_ENDPOINT)
  const queue = new SQSQueueAdapter({
    region: env.SQS_REGION,
    queueUrl: env.SQS_QUEUE_URL,
    endpoint: env.SQS_ENDPOINT,
    accessKeyId: env.SQS_ACCESS_KEY,
    secretAccessKey: env.SQS_SECRET_KEY,
    logger: logger.child({ component: 'sqs' }),
  })

  // Search adapter
  // dbSearch: always PostgreSQL for dashboard (consistent with DB)
  const dbSearch = new PostgresSearchAdapter(db)
  let search
  if (env.SEARCH_TYPE === 'postgres') {
    search = dbSearch
  } else if (env.SEARCH_TYPE === 'opensearch') {
    const osLogger = logger.child({ component: 'opensearch' })
    const osAdapter = new OpenSearchAdapter({
      endpoint: env.OPENSEARCH_URL,
      replicas: env.OPENSEARCH_REPLICAS,
      logger: osLogger,
      onIndexRecreated: async () => {
        // Auto-recovery guarantees metadata (packages + resources) rebuild only.
        // Content re-enqueue is best-effort; failures are logged but not retried.
        // If content indexing fails, use admin UI "enqueue all" to manually retry.
        await rebuildMetadataIndex(db, osAdapter, osLogger, false)
        new PipelineService(db, queue)
          .enqueueAll()
          .then(({ enqueued, failed }) => {
            if (failed > 0) osLogger.warn({ enqueued, failed }, 'Content re-enqueue partially failed')
          })
          .catch((err) => {
            osLogger.error({ err }, 'Content re-enqueue failed')
          })
      },
    })
    search = osAdapter
  } else {
    throw new Error(`Unknown search type: ${env.SEARCH_TYPE}`)
  }

  // AI adapter
  let ai
  if (env.AI_TYPE === 'none') {
    ai = new NoOpAIAdapter()
  } else {
    // Bedrock/OpenAI/Ollama - Phase 5
    throw new Error(`AI type ${env.AI_TYPE} not implemented yet (Phase 5)`)
  }

  return { storage, search, dbSearch, queue, ai }
}
