/**
 * KUKAN Environment Variable Validation
 * Zod-based type-safe environment configuration
 */

import { z } from 'zod'
import { passwordMinScoreSchema } from './password-strength'

const booleanString = z.preprocess(
  (v) => (typeof v === 'string' ? v : String(v)),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
)

/** Optional value where '' means unset — compose `${VAR:-}` injects empty strings */
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v)

/** A number with a default, where '' (compose `${VAR:-}`) means unset rather than 0 */
const numberOr = (fallback: number) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().default(fallback))

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

/** True for a name Intl resolves, e.g. `Asia/Tokyo` or `UTC`. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const DEFAULT_TIME_ZONE = 'Asia/Tokyo'

/**
 * The zone the web prerenders times in. The browser reformats them in the
 * viewer's zone once it runs; this one is what viewers see first, and what a
 * crawler reads. Exported on its own because the web reads TIME_ZONE without
 * the rest of the schema, and CDK validates the value at synth.
 */
export const timeZoneSchema = z.preprocess(
  // Empty means unset, as with the AI vars below: `TIME_ZONE=` is the default.
  emptyAsUndefined,
  z.string().refine(isTimeZone, 'must be an IANA time zone name').default(DEFAULT_TIME_ZONE)
)

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ...postgresSchema.shape,
  // DB Connection Pool — Web
  WEB_DB_POOL_MAX: numberOr(5),
  WEB_DB_POOL_IDLE_TIMEOUT_MS: numberOr(30_000),
  WEB_DB_POOL_CONNECTION_TIMEOUT_MS: numberOr(3_000),
  // DB Connection Pool — Worker
  WORKER_DB_POOL_MAX: numberOr(5),
  WORKER_DB_POOL_IDLE_TIMEOUT_MS: numberOr(10_000),
  WORKER_DB_POOL_CONNECTION_TIMEOUT_MS: numberOr(30_000),
  // Jobs one worker runs at once; unset, derived from WORKER_DB_POOL_MAX (ADR-058 §7)
  WORKER_CONCURRENCY: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).optional()),
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

  // Queue (ADR-058). The jobs are in the database; this is where the web tells
  // the worker to look. Unset → no signal, and a job waits for the worker's
  // next start or hourly sweep — except in development (`loadEnv`).
  WORKER_WAKE_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),
  // The site the worker reports its waiting jobs for, as a CloudWatch metric
  // to scale on (ADR-058 §4). Set by the AWS deployment where the worker
  // scales; unset → nothing is reported.
  WORKER_METRIC_SITE: z.preprocess(emptyAsUndefined, z.string().optional()),

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
  // Automatic resource abstracts (ADR-053): the model to write them with, and
  // by its absence the switch that turns them off.
  //
  // One setting rather than a flag and a model, because they are one decision —
  // what this deployment will spend on abstracts — and it belongs to whoever
  // pays for the inference rather than to the administrator who would flip a
  // toggle. Choosing between models is a threefold difference in the bill and,
  // measured, the difference between reading a scan and inventing one, so it is
  // not a thing to leave to whatever happens to be first in the allow-list.
  //
  // Unset writes nothing and costs nothing; a site that sets it later builds
  // the abstracts by reprocessing. Must name a model from AI_COMPLETION_MODELS.
  // The generation language stays a runtime setting: language is free, the
  // model is money.
  AI_SUMMARY_MODEL: z.preprocess(emptyAsUndefined, z.string().optional()),
  BEDROCK_REGION: z.string().default('ap-northeast-1'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  // Default matches the compose-mapped host port (11435 — avoids colliding
  // with a natively installed Ollama). Native install: set to :11434.
  OLLAMA_URL: z.string().default('http://localhost:11435'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  PASSWORD_MIN_SCORE: passwordMinScoreSchema,
  BETTER_AUTH_URL: z
    .url()
    .default(
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
    ),

  TIME_ZONE: timeZoneSchema,

  /**
   * The site the worker names in its User-Agent, so the operator of a server it
   * fetches from can reach whoever runs this catalog. Unset, it names only
   * itself: whether the site is public is not something the worker can tell
   * from its own address, so a closed site's URL is never sent unless asked.
   */
  // Normalized: a header carries ASCII only, so a Unicode host becomes punycode
  // here instead of failing every request the worker makes
  USER_AGENT_URL: z.preprocess(
    emptyAsUndefined,
    z
      .url({ protocol: /^https?$/ })
      .transform((url) => new URL(url).href)
      .optional()
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
 * How long a version-pinned OData page may be held (seconds), by anything that
 * holds it — the origin says it in `Cache-Control`, CloudFront caps its
 * behaviour at it.
 *
 * The bound is not staleness but withdrawal. Three things take a published page
 * away — purging the version being served (which moves serving to an older one),
 * making the dataset private, and deleting the resource — and in all three the
 * origin refuses from that moment while a copy already in a cache does not.
 * Purging an *older* version is not among them: the feed never served it.
 *
 * A purge is a deletion in what the catalogue promises (ADR-026, ADR-055), so
 * the window is minutes rather than the day the bytes' immutability would
 * justify. One number, because the TTL that matters is the longest anyone
 * applies.
 */
export const PINNED_PAGE_MAX_AGE_S = 600

/**
 * The origin this deployment answers on, without a trailing slash.
 *
 * `BETTER_AUTH_URL` is where it is configured — CDK sets it per site to the
 * custom domain or the distribution's own name — and it is read for more than
 * auth: the web app's metadata base and the OData feed's context and next links
 * are both statements about the same origin, and a link built from the request
 * instead would carry the load balancer's name (ADR-055).
 *
 * TODO: a dedicated SITE_URL would say what this is for; until then, one
 * function so the reading is in one place rather than spelled out per caller.
 */
export function publicOrigin(env: Pick<Env, 'BETTER_AUTH_URL'>): string {
  return env.BETTER_AUTH_URL.replace(/\/+$/, '')
}

/**
 * Load and validate environment variables.
 * DATABASE_URL is always constructed from POSTGRES_* variables.
 * @returns Validated environment configuration
 * @throws {z.ZodError} if validation fails
 */
export function loadEnv(): Env {
  const parsed = envSchema.parse(process.env)
  return {
    ...parsed,
    DATABASE_URL: urlFrom(parsed),
    WORKER_WAKE_URL: parsed.WORKER_WAKE_URL ?? devWakeUrl(parsed.NODE_ENV),
  }
}

/**
 * Where `pnpm dev` runs the worker, so a `.env` from before ADR-058 still
 * wakes it. Development only: production deployments set it, and under test
 * it would signal whatever dev worker happens to be running.
 */
function devWakeUrl(nodeEnv: Env['NODE_ENV']): string | undefined {
  return nodeEnv === 'development' ? 'http://localhost:8080/wake' : undefined
}

function urlFrom(p: z.infer<typeof postgresSchema>): string {
  return `postgresql://${p.POSTGRES_USER}:${p.POSTGRES_PASSWORD}@${p.POSTGRES_HOST}:${p.POSTGRES_PORT}/${p.POSTGRES_DB}`
}

/**
 * The same DATABASE_URL {@link loadEnv} builds, for callers that need the
 * database and nothing else.
 *
 * The test bootstrap and drizzle-kit are not services: demanding an auth secret
 * of them, as the full schema does, only means an unrelated gap in `.env` stops
 * the migrations or the suite. They still must not invent their
 * own reading of POSTGRES_* — that is how the tests came to sit on localhost
 * while the project pointed elsewhere.
 */
export function databaseUrl(): string {
  return urlFrom(postgresSchema.parse(process.env))
}
