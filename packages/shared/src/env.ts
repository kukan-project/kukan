/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'

const booleanString = z.preprocess(
  (v) => (typeof v === 'string' ? v : String(v)),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
)

/** Optional value where '' means unset — compose `${VAR:-}` injects empty strings */
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v)

/** Where Postgres is. Its own schema so that {@link databaseUrl} can answer
 *  without the rest of the environment having to be present. */
const postgresSchema = z.object({
  POSTGRES_HOST: z.string().default('localhost'),
  // Bounded, so that a port no URL can hold is refused by name here rather than
  // surfacing further down as `Invalid URL` against the whole string.
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: z.string().default('kukan'),
  POSTGRES_USER: z.string().default('kukan'),
  POSTGRES_PASSWORD: z.string().default('kukan'),
  POSTGRES_SSLMODE: z.enum(['disable', 'require']).default('disable'),
})

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ...postgresSchema.shape,
  // DB Connection Pool — Web
  WEB_DB_POOL_MAX: z.coerce.number().default(5),
  WEB_DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(30_000),
  WEB_DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().default(3_000),
  // DB Connection Pool — Worker
  WORKER_DB_POOL_MAX: z.coerce.number().default(3),
  WORKER_DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(10_000),
  WORKER_DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().default(30_000),
  PORT: z.coerce.number().default(3000),

  // Storage (S3-compatible: AWS S3 or MinIO, determined by S3_ENDPOINT)
  S3_BUCKET: z.string().default('kukan-dev'),
  S3_REGION: z.string().default('ap-northeast-1'),
  S3_ENDPOINT: z.string().optional(), // MinIO: http://localhost:9000, S3: omit (use default)
  S3_ACCESS_KEY: z.string().optional(), // MinIO: required, S3: use IAM role
  S3_SECRET_KEY: z.string().optional(), // MinIO: required, S3: use IAM role

  // Search (opensearch recommended; postgres fallback for cost savings)
  SEARCH_TYPE: z.enum(['opensearch', 'postgres']).default('opensearch'),
  OPENSEARCH_URL: z.string().default('http://localhost:9200'),
  OPENSEARCH_REPLICAS: z.coerce.number().int().min(0).default(0),
  // Index name prefix (`<prefix>-search`). Per-site isolation on a shared
  // OpenSearch domain (ADR-041)
  OPENSEARCH_INDEX_PREFIX: z.string().default('kukan'),
  // Minimum cosine similarity for vector-search hits. Omit → the embedding
  // model's measured recommendation (EmbeddingInfo.recommendedMinSimilarity),
  // falling back to 0.45 for unmeasured models
  SEARCH_VECTOR_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).optional(),

  // Queue (SQS-compatible: AWS SQS or ElasticMQ, determined by SQS_ENDPOINT)
  SQS_QUEUE_URL: z.string(),
  SQS_ENDPOINT: z.string().optional(), // ElasticMQ: http://localhost:9324, SQS: omit
  SQS_REGION: z.string().default('ap-northeast-1'),
  SQS_ACCESS_KEY: z.string().optional(), // ElasticMQ: required, AWS SQS: use IAM role
  SQS_SECRET_KEY: z.string().optional(),

  // Health Check
  HEALTH_CHECK_ENABLED: booleanString.default(true),
  HEALTH_CHECK_CRON: z.string().default('*/5 * * * *'),
  HEALTH_CHECK_STALENESS_HOURS: z.coerce.number().default(24),
  HEALTH_CHECK_FULL_FETCH_INTERVAL_HOURS: z.coerce.number().default(168),

  // AI
  AI_TYPE: z.enum(['bedrock', 'openai', 'ollama', 'none']).default('none'),
  AI_EMBEDDING_MODEL: z.preprocess(emptyAsUndefined, z.string().optional()), // adapter defaults: Titan v2 / bge-m3 / text-embedding-3-small
  AI_EMBEDDING_DIMENSIONS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().positive().optional()
  ),
  AI_COMPLETION_MODELS: z.preprocess(emptyAsUndefined, z.string().optional()), // comma-separated allow-list = picker options, first = default; omit → built-in default
  BEDROCK_REGION: z.string().default('ap-northeast-1'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  // Default matches the compose-mapped host port (11435 — avoids colliding
  // with a natively installed Ollama). Native install: set to :11434.
  OLLAMA_URL: z.string().default('http://localhost:11435'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z
    .url()
    .default(
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
    ),

  // GA4 Analytics (optional — dashboard disabled when not set)
  GA4_PROPERTY_ID: z.string().optional(),
  GA4_CLIENT_EMAIL: z.string().optional(),
  GA4_PRIVATE_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema> & {
  DATABASE_URL: string
}

/**
 * Load and validate environment variables.
 * DATABASE_URL is always constructed from POSTGRES_* variables.
 * @returns Validated environment configuration
 * @throws {z.ZodError} if validation fails
 */
export function loadEnv(): Env {
  const parsed = envSchema.parse(process.env)
  return { ...parsed, DATABASE_URL: urlFrom(parsed) }
}

function urlFrom(p: z.infer<typeof postgresSchema>): string {
  return `postgresql://${p.POSTGRES_USER}:${p.POSTGRES_PASSWORD}@${p.POSTGRES_HOST}:${p.POSTGRES_PORT}/${p.POSTGRES_DB}`
}

/**
 * The same DATABASE_URL {@link loadEnv} builds, for callers that need the
 * database and nothing else.
 *
 * The test bootstrap and drizzle-kit are not services: demanding a queue URL and
 * an auth secret of them, as the full schema does, only means an unrelated gap
 * in `.env` stops the migrations or the suite. They still must not invent their
 * own reading of POSTGRES_* — that is how the tests came to sit on localhost
 * while the project pointed elsewhere.
 */
export function databaseUrl(): string {
  return urlFrom(postgresSchema.parse(process.env))
}
