/**
 * Concurrent migration runs.
 *
 * Every Worker task migrates at boot, and a deployment starts more than one —
 * so two runs against the same database at the same time is the normal case,
 * not an edge one. Without the advisory lock the second run raced the first
 * inside `CREATE EXTENSION IF NOT EXISTS` and one of the two tasks died on
 * `duplicate key value violates unique constraint "pg_extension_name_index"`.
 */

import { describe, it, expect, inject, vi, afterEach } from 'vitest'
import { Client } from 'pg'
import { setTimeout as sleep } from 'node:timers/promises'
import { runMigrations } from '../migrate'
import { scratchUrl } from './test-helpers/global-setup'

// Made here rather than taken from @kukan/db-testing — that package depends on
// this one — and empty, which is the one database its harness cannot hand out:
// an already-migrated one leaves two runners nothing to collide over. The
// project's teardown drops it.
const NAME = `${inject('migrateScratchPrefix')}_${process.pid}`

/** An empty database under this file's name; the second test reuses it. */
async function freshDatabase(): Promise<string> {
  const server = new Client({ connectionString: scratchUrl('postgres') })
  await server.connect()
  try {
    await server.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`)
    await server.query(`CREATE DATABASE ${NAME}`)
  } finally {
    await server.end()
  }
  return scratchUrl(NAME)
}

async function appliedMigrations(url: string): Promise<number> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
    )
    return rows[0].n
  } finally {
    await client.end()
  }
}

describe('runMigrations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lets two processes migrate the same fresh database at once', async () => {
    const url = await freshDatabase()
    const runs = await Promise.allSettled([runMigrations(url), runMigrations(url)])

    expect(runs.map((r) => (r.status === 'rejected' ? String(r.reason) : 'fulfilled'))).toEqual([
      'fulfilled',
      'fulfilled',
    ])
    expect(await appliedMigrations(url)).toBeGreaterThan(0)
  })

  it('retries after a lock timeout instead of failing the boot', async () => {
    const url = await freshDatabase()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The table drizzle reads first, made ahead of it and held ACCESS EXCLUSIVE
    // — the stand-in for the old-image Worker that keeps ACCESS SHARE on a
    // table the DDL wants, since an empty database has none of those yet.
    const holder = new Client({ connectionString: url })
    await holder.connect()
    await holder.query('CREATE SCHEMA drizzle')
    await holder.query(
      'CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
    )
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE')

    const run = runMigrations(url, { lockTimeoutMs: 500, retryDelayMs: 1000, attempts: 5 })
    // Past the first attempt's timeout, before the second attempt starts.
    await sleep(1200)
    await holder.query('ROLLBACK')
    await holder.end()

    await expect(run).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Attempt 1/5 timed out'))
    expect(await appliedMigrations(url)).toBeGreaterThan(0)
  })

  it('gives up once the attempts are spent', async () => {
    const url = await freshDatabase()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const holder = new Client({ connectionString: url })
    await holder.connect()
    await holder.query('CREATE SCHEMA drizzle')
    await holder.query(
      'CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
    )
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE')
    try {
      // Drizzle wraps the pg error; the SQLSTATE is on the cause.
      const err = await runMigrations(url, { lockTimeoutMs: 200, retryDelayMs: 100, attempts: 2 })
        .then(() => null)
        .catch((e: unknown) => e as Error & { cause?: { code?: string } })
      expect(err?.cause?.code).toBe('55P03')
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
    }
  })
})
