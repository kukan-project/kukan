import { existsSync } from 'node:fs'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { forgetEnvironmentCredentials, loadDuckdbExtensions } from '../config'
import { openDuckdb, sealDuckdb } from '../duckdb'

async function setting(conn: Awaited<ReturnType<typeof openDuckdb>>['conn'], name: string) {
  const reader = await conn.runAndReadAll(`SELECT current_setting('${name}') AS v`)
  return String((reader.getRowObjectsJson()[0] as { v: unknown }).v)
}

describe('openDuckdb', () => {
  it('applies the bounds as creation options', async () => {
    const { conn, close } = await openDuckdb({
      memoryLimitBytes: 64_000_000,
      threads: 1,
      spill: null,
    })
    try {
      // 64,000,000 bytes, which DuckDB reports in binary units.
      expect(await setting(conn, 'memory_limit')).toBe('61.0 MiB')
      expect(await setting(conn, 'threads')).toBe('1')
    } finally {
      await close()
    }
  })

  it('gives the instance a spill directory of its own and removes it on close', async () => {
    const { conn, close } = await openDuckdb({ spill: 'test' })
    const dir = await setting(conn, 'temp_directory')
    expect(dir).toMatch(/kukan-test-tmp-/)
    expect(existsSync(dir)).toBe(true)

    await close()
    expect(existsSync(dir)).toBe(false)
  })

  it('leaves the removal to the owner through dropTempDir', async () => {
    // The lake's shape: the instance outlives this connection, and the
    // directory goes when the last session on it lets go.
    const { instance, conn, dropTempDir } = await openDuckdb({ spill: 'test' })
    const dir = await setting(conn, 'temp_directory')
    conn.disconnectSync()
    instance.closeSync()
    expect(existsSync(dir)).toBe(true)

    await dropTempDir()
    expect(existsSync(dir)).toBe(false)
  })
})

describe('sealDuckdb', () => {
  it('refuses any setting changed after it', async () => {
    const { conn, close } = await openDuckdb({ spill: null })
    try {
      await sealDuckdb(conn)
      await expect(conn.run('SET threads = 2')).rejects.toThrow(/lock/i)
      expect(await setting(conn, 'autoload_known_extensions')).toBe('false')
    } finally {
      await close()
    }
  })
})

describe('forgetEnvironmentCredentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('empties what httpfs took from the environment for every connection, not just its own', async () => {
    // httpfs reads these when it loads; a plain SET would clear them on this
    // connection and leave the instance's value for the next one to read.
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'from-the-environment')
    const { instance, conn, close } = await openDuckdb({ spill: null })
    try {
      await loadDuckdbExtensions(conn, ['httpfs'])
      expect(await setting(conn, 's3_access_key_id')).toBe('from-the-environment')

      await forgetEnvironmentCredentials(conn)
      const next = await instance.connect()
      try {
        expect(await setting(conn, 's3_access_key_id')).toBe('')
        expect(await setting(next, 's3_access_key_id')).toBe('')
      } finally {
        next.disconnectSync()
      }
    } finally {
      await close()
    }
  })
})
