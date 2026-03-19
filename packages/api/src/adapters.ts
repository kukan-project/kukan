/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env } from '@kukan/shared'
import type { Database } from '@kukan/db'
import { S3CompatibleStorageAdapter, LocalStorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter, OpenSearchAdapter } from '@kukan/search-adapter'
import { InProcessQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'

export async function createAdapters(env: Env, db: Database) {
  // Storage adapter
  let storage
  if (env.STORAGE_TYPE === 'local') {
    storage = new LocalStorageAdapter({
      basePath: './data/storage',
    })
  } else {
    // S3-compatible (AWS S3 or MinIO — determined by S3_ENDPOINT presence)
    storage = new S3CompatibleStorageAdapter({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    })
  }

  // Search adapter
  let search
  if (env.SEARCH_TYPE === 'postgres') {
    search = new PostgresSearchAdapter(db)
  } else if (env.SEARCH_TYPE === 'opensearch') {
    if (!env.OPENSEARCH_URL) {
      throw new Error('OpenSearch requires OPENSEARCH_URL')
    }
    const osAdapter = new OpenSearchAdapter({ endpoint: env.OPENSEARCH_URL })
    await osAdapter.ensureIndex()
    search = osAdapter
  } else {
    throw new Error(`Unknown search type: ${env.SEARCH_TYPE}`)
  }

  // Queue adapter
  let queue
  if (env.QUEUE_TYPE === 'in-process') {
    queue = new InProcessQueueAdapter()
  } else {
    // SQS - Phase 3b
    throw new Error('SQS queue not implemented yet (Phase 3b)')
  }

  // AI adapter
  let ai
  if (env.AI_TYPE === 'none') {
    ai = new NoOpAIAdapter()
  } else {
    // Bedrock/OpenAI/Ollama - Phase 5
    throw new Error(`AI type ${env.AI_TYPE} not implemented yet (Phase 5)`)
  }

  return {
    storage,
    search,
    queue,
    ai,
  }
}
