/**
 * KUKAN Adapter Factory
 * Creates adapter instances based on environment configuration
 */

import type { Env, Logger } from '@kukan/shared'
import { parseCompletionModels } from '@kukan/shared/ai'
import type { Database } from '@kukan/db'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter, OpenSearchAdapter } from '@kukan/search-adapter'
import {
  type AIAdapter,
  type MeteredAI,
  NoOpAIAdapter,
  BedrockAIAdapter,
  OpenAIAdapter,
  OllamaAdapter,
  meterAI,
} from '@kukan/ai-adapter'
import { createAiUsageRecorder, type AiUsageRecorder } from './services/ai/ai-usage-recorder'

const globalForSearch = globalThis as unknown as {
  __kukanOpenSearchAdapter?: OpenSearchAdapter
}

// One recorder per process: in development the app is rebuilt per request,
// and a recorder each would leave a timer each, and split one quarter's sums
const globalForUsage = globalThis as unknown as { __kukanAiUsage?: AiUsageRecorder }

/** Write the usage held in memory; for the process's shutdown, before the pool closes */
export async function flushAiUsage(): Promise<void> {
  await globalForUsage.__kukanAiUsage?.stop()
}

/** The provider adapter from env — never handed out bare, only metered (below) */
function createAIAdapter(env: Env): AIAdapter {
  if (env.AI_TYPE === 'none') {
    return new NoOpAIAdapter()
  }
  const completionModels = parseCompletionModels(env.AI_COMPLETION_MODELS)
  if (env.AI_TYPE === 'bedrock') {
    return new BedrockAIAdapter({
      region: env.BEDROCK_REGION,
      embeddingModel: env.AI_EMBEDDING_MODEL,
      embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
      completionModels,
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
      completionModels,
    })
  }
  return new OllamaAdapter({
    baseUrl: env.OLLAMA_URL,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
    completionModels,
  })
}

/**
 * The AI adapter from env, with every call it completes recorded to
 * `ai_usage` — the one the application is given (also used by the worker).
 */
export function createMeteredAI(
  env: Env,
  db: Database,
  logger: Logger
): { ai: MeteredAI; usage: AiUsageRecorder } {
  const usage = (globalForUsage.__kukanAiUsage ??= createAiUsageRecorder(
    db,
    logger.child({ component: 'ai-usage' })
  ))
  return { ai: meterAI(createAIAdapter(env), usage.sink), usage }
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

  // AI adapter (created before search — its model knows the similarity floor)
  const { ai } = createMeteredAI(env, db, logger)

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
        indexPrefix: env.OPENSEARCH_INDEX_PREFIX,
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

  return { storage, search, dbSearch, ai }
}
