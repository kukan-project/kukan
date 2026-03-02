/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env } from '@kukan/shared'
import { MinIOStorageAdapter, LocalStorageAdapter } from '@kukan/storage'
import { PostgresSearchAdapter } from '@kukan/search'
import { InProcessQueueAdapter } from '@kukan/queue'
import { NoOpAIAdapter } from '@kukan/ai'

export function createAdapters(env: Env) {
  // Storage adapter
  let storage
  if (env.STORAGE_TYPE === 'local') {
    storage = new LocalStorageAdapter({
      basePath: './data/storage',
    })
  } else if (env.STORAGE_TYPE === 'minio') {
    storage = new MinIOStorageAdapter({
      endpoint: env.MINIO_ENDPOINT,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
    })
  } else {
    // S3 - Phase 5
    throw new Error('S3 storage not implemented yet (Phase 5)')
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
