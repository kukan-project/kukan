import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { envSchema, loadEnv, databaseUrl } from '../env'

describe('envSchema', () => {
  it('should apply defaults for optional fields', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.NODE_ENV).toBe('development')
    expect(result.data.LOG_LEVEL).toBe('info')
    expect(result.data.POSTGRES_HOST).toBe('localhost')
    expect(result.data.POSTGRES_PORT).toBe(5432)
    expect(result.data.POSTGRES_DB).toBe('kukan')
    expect(result.data.PORT).toBe(3000)
    expect(result.data.SEARCH_TYPE).toBe('opensearch')
    expect(result.data.AI_TYPE).toBe('none')
    expect(result.data.HEALTH_CHECK_ENABLED).toBe(true)
  })

  it('should reject missing required fields', () => {
    const result = envSchema.safeParse({})

    expect(result.success).toBe(false)
    if (result.success) return
    const paths = result.error.issues.map((i) => i.path[0])
    expect(paths).toContain('SQS_QUEUE_URL')
    expect(paths).toContain('BETTER_AUTH_SECRET')
  })

  it('should reject BETTER_AUTH_SECRET shorter than 32 chars', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'short',
    })

    expect(result.success).toBe(false)
  })

  it('should coerce string numbers to numbers', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      POSTGRES_PORT: '5433',
      PORT: '8080',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.POSTGRES_PORT).toBe(5433)
    expect(result.data.PORT).toBe(8080)
  })

  it('should take a non-default POSTGRES_PORT and reject one no URL can hold', () => {
    const parse = (POSTGRES_PORT: string) =>
      envSchema.safeParse({
        SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
        BETTER_AUTH_SECRET: 'a'.repeat(32),
        POSTGRES_PORT,
      })

    // A second Postgres beside the first is an ordinary thing to test against
    expect(parse('5433').success).toBe(true)
    expect(parse('65535').success).toBe(true)
    // Out of range says POSTGRES_PORT here, rather than `Invalid URL` further down
    expect(parse('65536').success).toBe(false)
    expect(parse('0').success).toBe(false)
  })

  it('should parse boolean strings correctly', () => {
    const parse = (overrides: Record<string, string>) =>
      envSchema.safeParse({
        SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
        BETTER_AUTH_SECRET: 'a'.repeat(32),
        ...overrides,
      })

    const trueResult = parse({ HEALTH_CHECK_ENABLED: '1' })
    expect(trueResult.success).toBe(true)
    if (!trueResult.success) return
    expect(trueResult.data.HEALTH_CHECK_ENABLED).toBe(true)

    const falseResult = parse({ HEALTH_CHECK_ENABLED: '0' })
    expect(falseResult.success).toBe(true)
    if (!falseResult.success) return
    expect(falseResult.data.HEALTH_CHECK_ENABLED).toBe(false)
  })

  it('should reject invalid boolean strings', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      HEALTH_CHECK_ENABLED: 'yes',
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid SEARCH_TYPE', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      SEARCH_TYPE: 'elasticsearch',
    })

    expect(result.success).toBe(false)
  })

  it('should reject invalid NODE_ENV', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      NODE_ENV: 'staging',
    })

    expect(result.success).toBe(false)
  })

  it('should treat empty AI model vars as unset (compose ${VAR:-} injects empty strings)', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      AI_EMBEDDING_MODEL: '',
      AI_EMBEDDING_DIMENSIONS: '',
      AI_COMPLETION_MODELS: '',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.AI_EMBEDDING_MODEL).toBeUndefined()
    expect(result.data.AI_EMBEDDING_DIMENSIONS).toBeUndefined()
    expect(result.data.AI_COMPLETION_MODELS).toBeUndefined()
  })

  it('should pass through non-empty AI model vars', () => {
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      AI_COMPLETION_MODELS: 'qwen3:8b,gemma4:e4b',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.AI_COMPLETION_MODELS).toBe('qwen3:8b,gemma4:e4b')
  })

  it('should validate OPENSEARCH_REPLICAS constraints', () => {
    const valid = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      OPENSEARCH_REPLICAS: '2',
    })
    expect(valid.success).toBe(true)

    const invalid = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      OPENSEARCH_REPLICAS: '-1',
    })
    expect(invalid.success).toBe(false)
  })
})

describe('loadEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should construct DATABASE_URL from POSTGRES_* vars', () => {
    const env = loadEnv()

    expect(env.DATABASE_URL).toBe('postgresql://kukan:kukan@localhost:5432/kukan')
  })

  it('should construct DATABASE_URL with custom POSTGRES vars', () => {
    process.env.POSTGRES_HOST = 'db.example.com'
    process.env.POSTGRES_PORT = '5433'
    process.env.POSTGRES_DB = 'mydb'
    process.env.POSTGRES_USER = 'myuser'
    process.env.POSTGRES_PASSWORD = 'mypass'

    const env = loadEnv()

    expect(env.DATABASE_URL).toBe('postgresql://myuser:mypass@db.example.com:5433/mydb')
  })

  it('databaseUrl matches what loadEnv builds', () => {
    process.env.POSTGRES_HOST = 'db.example.com'
    process.env.POSTGRES_PORT = '5433'

    expect(databaseUrl()).toBe(loadEnv().DATABASE_URL)
  })

  it('databaseUrl answers without the rest of the environment', () => {
    // The test bootstrap and drizzle-kit have no queue and no auth secret, and
    // asking them for one only breaks the migrations over an unrelated gap
    delete process.env.SQS_QUEUE_URL
    delete process.env.BETTER_AUTH_SECRET
    process.env.POSTGRES_HOST = 'db.example.com'

    expect(() => loadEnv()).toThrow()
    expect(databaseUrl()).toBe('postgresql://kukan:kukan@db.example.com:5432/kukan')
  })

  it('should throw on invalid environment', () => {
    delete process.env.SQS_QUEUE_URL
    delete process.env.BETTER_AUTH_SECRET

    expect(() => loadEnv()).toThrow()
  })
})
