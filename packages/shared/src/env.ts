/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),

  // Storage
  STORAGE_TYPE: z.enum(['s3', 'minio', 'local']).default('minio'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-northeast-1'),
  MINIO_ENDPOINT: z.string().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),

  // Search
  SEARCH_TYPE: z.enum(['opensearch', 'postgres']).default('postgres'),
  OPENSEARCH_URL: z.string().optional(),

  // Queue
  QUEUE_TYPE: z.enum(['sqs', 'in-process']).default('in-process'),
  SQS_QUEUE_URL: z.string().optional(),

  // AI
  AI_TYPE: z.enum(['bedrock', 'openai', 'ollama', 'none']).default('none'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
})

export type Env = z.infer<typeof envSchema>

/**
 * Load and validate environment variables
 * @returns Validated environment configuration
 * @throws {z.ZodError} if validation fails
 */
export function loadEnv(): Env {
  return envSchema.parse(process.env)
}
