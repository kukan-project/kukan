import { describe, it, expect } from 'vitest'
import type { Env } from '@kukan/shared'
import { lakeConfigFromEnv } from '../config'
import { lakeTableName } from '../table'

function envWith(overrides: Partial<Env>): Env {
  return {
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: 5432,
    POSTGRES_DB: 'kukan',
    POSTGRES_USER: 'kukan',
    POSTGRES_PASSWORD: 'pw',
    POSTGRES_SSLMODE: 'disable',
    S3_BUCKET: 'kukan-dev',
    S3_REGION: 'ap-northeast-1',
    ...overrides,
  } as Env
}

describe('lakeTableName', () => {
  it('derives res_<uuid without hyphens> from a resource id', () => {
    expect(lakeTableName('429ff69d-7b24-4a8f-a0ec-671bcceee31e')).toBe(
      'res_429ff69d7b244a8fa0ec671bcceee31e'
    )
  })
})

describe('lakeConfigFromEnv', () => {
  it('builds a libpq keyword connection string for the catalog', () => {
    const c = lakeConfigFromEnv(envWith({}))
    // connect_timeout bounds ATTACH, which cannot be interrupted from Node.
    expect(c.pgConnString).toBe(
      'host=localhost port=5432 dbname=kukan user=kukan password=pw sslmode=disable connect_timeout=10'
    )
  })

  it('splits a MinIO endpoint URL into host and ssl flag (path-style)', () => {
    const c = lakeConfigFromEnv(
      envWith({ S3_ENDPOINT: 'http://localhost:9000', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' })
    )
    expect(c.s3Endpoint).toBe('localhost:9000')
    expect(c.s3UseSsl).toBe(false)
    expect(c.s3AccessKey).toBe('k')
  })

  it('leaves the endpoint undefined for AWS S3 (no S3_ENDPOINT)', () => {
    const c = lakeConfigFromEnv(envWith({}))
    expect(c.s3Endpoint).toBeUndefined()
    expect(c.s3UseSsl).toBe(true)
  })

  it('reads https endpoints as ssl (default port omitted by URL.host)', () => {
    const c = lakeConfigFromEnv(envWith({ S3_ENDPOINT: 'https://minio.example:443' }))
    expect(c.s3Endpoint).toBe('minio.example')
    expect(c.s3UseSsl).toBe(true)
  })
})
