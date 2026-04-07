/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default('kukan'),
  POSTGRES_USER: z.string().default('kukan'),
  POSTGRES_PASSWORD: z.string().default('kukan'),
  POSTGRES_SSLMODE: z.enum(['disable', 'require']).default('disable'),
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

  // Queue (SQS-compatible: AWS SQS or ElasticMQ, determined by SQS_ENDPOINT)
  SQS_QUEUE_URL: z.string(),
  SQS_ENDPOINT: z.string().optional(), // ElasticMQ: http://localhost:9324, SQS: omit
  SQS_REGION: z.string().default('ap-northeast-1'),
  SQS_ACCESS_KEY: z.string().optional(), // ElasticMQ: required, AWS SQS: use IAM role
  SQS_SECRET_KEY: z.string().optional(),

  // AI
  AI_TYPE: z.enum(['bedrock', 'openai', 'ollama', 'none']).default('none'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z
    .string()
    .url()
    .default(
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
    ),
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
  const DATABASE_URL = `postgresql://${parsed.POSTGRES_USER}:${parsed.POSTGRES_PASSWORD}@${parsed.POSTGRES_HOST}:${parsed.POSTGRES_PORT}/${parsed.POSTGRES_DB}`
  return { ...parsed, DATABASE_URL }
}
