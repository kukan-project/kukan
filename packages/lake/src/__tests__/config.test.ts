import { describe, it, expect } from 'vitest'
import { stat } from 'node:fs/promises'
import type { Env } from '@kukan/shared'
import { lakeConfigFromEnv } from '../config'
import { useOwnTempDirectory } from '../spill'
import { lakeTableName, lakeTableResourceIds } from '../table'
import type { LakeSession } from '../connection'

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

  it('is read back into the resource id, and nothing else is', async () => {
    const id = '429ff69d-7b24-4a8f-a0ec-671bcceee31e'
    const tables = [lakeTableName(id), 'res_short', 'orders']
    const session = { rows: async () => tables.map((table_name) => ({ table_name })) }
    expect(await lakeTableResourceIds(session as unknown as LakeSession)).toEqual([id])
  })
})

const limits = { memoryLimitMb: 256, threads: 1, catalogConnections: 1 }

describe('lakeConfigFromEnv', () => {
  it('builds a libpq keyword connection string for the catalog', () => {
    const c = lakeConfigFromEnv(envWith({}), limits)
    // connect_timeout bounds ATTACH, which cannot be interrupted from Node.
    expect(c.pgConnString).toBe(
      'host=localhost port=5432 dbname=kukan user=kukan password=pw sslmode=disable connect_timeout=10'
    )
  })

  it('splits a MinIO endpoint URL into host and ssl flag (path-style)', () => {
    const c = lakeConfigFromEnv(
      envWith({ S3_ENDPOINT: 'http://localhost:9000', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' }),
      limits
    )
    expect(c.s3Endpoint).toBe('localhost:9000')
    expect(c.s3UseSsl).toBe(false)
    expect(c.s3AccessKey).toBe('k')
  })

  it('leaves the endpoint undefined for AWS S3 (no S3_ENDPOINT)', () => {
    const c = lakeConfigFromEnv(envWith({}), limits)
    expect(c.s3Endpoint).toBeUndefined()
    expect(c.s3UseSsl).toBe(true)
  })

  it('reads https endpoints as ssl (default port omitted by URL.host)', () => {
    const c = lakeConfigFromEnv(envWith({ S3_ENDPOINT: 'https://minio.example:443' }), limits)
    expect(c.s3Endpoint).toBe('minio.example')
    expect(c.s3UseSsl).toBe(true)
  })
})

describe('useOwnTempDirectory', () => {
  it('holds for the instance, not for the connection that set it', async () => {
    // What the lake path rests on: it sets the directory on a setup connection
    // and then disconnects, so the setting has to be the instance's. DuckDB
    // scopes `temp_directory` GLOBAL, and nothing here would notice if that
    // changed — the spill files would quietly go back to the shared default.
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const instance = await DuckDBInstance.create(':memory:')
    const setup = await instance.connect()
    await useOwnTempDirectory(setup, 'test')
    setup.disconnectSync()

    const later = await instance.connect()
    const reader = await later.runAndReadAll(`SELECT current_setting('temp_directory') AS d`)
    expect((reader.getRowObjectsJson()[0] as { d: string }).d).toContain('kukan-test-tmp-')
    later.disconnectSync()
    instance.closeSync()
  })

  it('leaves no directory behind when the setting cannot be applied', async () => {
    // The caller gets no cleanup for a setting it never got, so the directory
    // would be stranded for the life of the container. A read deadline firing
    // during setup interrupts this very statement, so it is reachable.
    let asked = ''
    const failing = {
      run: async (sql: string) => {
        asked = sql
        throw new Error('interrupted')
      },
    }
    await expect(useOwnTempDirectory(failing, 'test')).rejects.toThrow('interrupted')

    const dir = asked.match(/'([^']+)'/)?.[1]
    expect(dir).toContain('kukan-test-tmp-')
    await expect(stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
