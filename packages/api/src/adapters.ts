/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env, Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter, OpenSearchAdapter } from '@kukan/search-adapter'
import { SQSQueueAdapter } from '@kukan/queue-adapter'
import {
  type AIAdapter,
  NoOpAIAdapter,
  BedrockAIAdapter,
  OpenAIAdapter,
  OllamaAdapter,
} from '@kukan/ai-adapter'

const globalForSearch = globalThis as unknown as {
  __kukanOpenSearchAdapter?: OpenSearchAdapter
}

/** Create the AI adapter from env (also used standalone by the worker) */
export function createAIAdapter(env: Env): AIAdapter {
  if (env.AI_TYPE === 'none') {
    return new NoOpAIAdapter()
  }
  if (env.AI_TYPE === 'bedrock') {
    return new BedrockAIAdapter({
      region: env.BEDROCK_REGION,
      embeddingModel: env.AI_EMBEDDING_MODEL,
      embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
      completionModels: env.BEDROCK_COMPLETION_MODELS?.split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    })
  }
  if (env.AI_TYPE === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when AI_TYPE=openai')
    }
    return new OpenAIAdapter({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      embeddingModel: env.AI_EMBEDDING_MODEL,
      embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
    })
  }
  return new OllamaAdapter({
    baseUrl: env.OLLAMA_URL,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
  })
}

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

  // AI adapter (created before search — its model knows the similarity floor)
  const ai = createAIAdapter(env)

  // Search adapter
  // dbSearch: always PostgreSQL for dashboard (consistent with DB) and vectors (ADR-034).
  // Floor precedence: explicit env > the embedding model's measured recommendation
  // > the adapter's built-in default.
  const dbSearch = new PostgresSearchAdapter(db, {
    vectorMinSimilarity:
      env.SEARCH_VECTOR_MIN_SIMILARITY ?? ai.getEmbeddingInfo()?.recommendedMinSimilarity,
  })
  let search
  if (env.SEARCH_TYPE === 'postgres') {
    search = dbSearch
  } else if (env.SEARCH_TYPE === 'opensearch') {
    // Reuse the adapter across HMR in development to prevent OpenSearch
    // connection leaks (mirrors the db pool singleton in @kukan/db).
    let osAdapter = globalForSearch.__kukanOpenSearchAdapter
    if (!osAdapter) {
      osAdapter = new OpenSearchAdapter({
        endpoint: env.OPENSEARCH_URL,
        replicas: env.OPENSEARCH_REPLICAS,
        logger: logger.child({ component: 'opensearch' }),
        // Auto-recovery (empty index detection) is handled by the Worker periodic check
      })
      if (process.env.NODE_ENV !== 'production') {
        globalForSearch.__kukanOpenSearchAdapter = osAdapter
      }
    }
    search = osAdapter
  } else {
    throw new Error(`Unknown search type: ${env.SEARCH_TYPE}`)
  }

  return { storage, search, dbSearch, queue, ai }
}
