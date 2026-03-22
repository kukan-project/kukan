/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
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

export type Env = z.infer<typeof envSchema>

/**
 * Load and validate environment variables
 * @returns Validated environment configuration
 * @throws {z.ZodError} if validation fails
 */
export function loadEnv(): Env {
  return envSchema.parse(process.env)
}
