/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env } from '@kukan/shared'
import { MinIOStorageAdapter, LocalStorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { InProcessQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'

export function createAdapters(env: Env) {
  // Storage adapter
  let storage
  if (env.STORAGE_TYPE === 'local') {
    storage = new LocalStorageAdapter({
      basePath: './data/storage',
    })
  } else if (env.STORAGE_TYPE === 'minio') {
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error('MinIO requires S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY')
    }
    storage = new MinIOStorageAdapter({
      endpoint: env.S3_ENDPOINT,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      bucket: env.S3_BUCKET,
    })
  } else {
    // S3 - Phase 2
    throw new Error('S3 storage not implemented yet (Phase 2)')
  }

  // Search adapter
  let search
  if (env.SEARCH_TYPE === 'postgres') {
    search = new PostgresSearchAdapter({
      connectionString: env.DATABASE_URL,
    })
  } else {
    // OpenSearch - Phase 2
    throw new Error('OpenSearch not implemented yet (Phase 2)')
  }

  // Queue adapter
  let queue
  if (env.QUEUE_TYPE === 'in-process') {
    queue = new InProcessQueueAdapter()
  } else {
    // SQS - Phase 2
    throw new Error('SQS queue not implemented yet (Phase 2)')
  }

  // AI adapter
  let ai
  if (env.AI_TYPE === 'none') {
    ai = new NoOpAIAdapter()
  } else {
    // Bedrock/OpenAI/Ollama - Phase 4
    throw new Error(`AI type ${env.AI_TYPE} not implemented yet (Phase 4)`)
  }

  return {
    storage,
    search,
    queue,
    ai,
  }
}
