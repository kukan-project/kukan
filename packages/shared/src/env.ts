/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),

  // Storage (S3-compatible: works with both AWS S3 and MinIO)
  STORAGE_TYPE: z.enum(['s3', 'minio', 'local']).default('local'),
  S3_BUCKET: z.string().default('kukan-dev'),
  S3_REGION: z.string().default('ap-northeast-1'),
  S3_ENDPOINT: z.string().optional(), // MinIO: http://localhost:9000, S3: omit (use default)
  S3_ACCESS_KEY: z.string().optional(), // MinIO: required, S3: use IAM role
  S3_SECRET_KEY: z.string().optional(), // MinIO: required, S3: use IAM role

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
