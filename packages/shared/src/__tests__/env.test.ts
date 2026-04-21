import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { envSchema, loadEnv } from '../env'

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
    expect(result.data.REGISTRATION_ENABLED).toBe(true)
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

  it('should coerce booleans from non-string values', () => {
    // z.coerce.boolean() uses Boolean() — any non-empty string is true
    const result = envSchema.safeParse({
      SQS_QUEUE_URL: 'http://localhost:9324/queue/test',
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      HEALTH_CHECK_ENABLED: 'true',
      REGISTRATION_ENABLED: 'true',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.HEALTH_CHECK_ENABLED).toBe(true)
    expect(result.data.REGISTRATION_ENABLED).toBe(true)
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

  it('should throw on invalid environment', () => {
    delete process.env.SQS_QUEUE_URL
    delete process.env.BETTER_AUTH_SECRET

    expect(() => loadEnv()).toThrow()
  })
})
