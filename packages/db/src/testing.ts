/**
 * Creating and migrating a database for an integration suite.
 *
 * Here because this package owns the migrations: the folder they live in is a
 * path relative to this file, and a suite that had to know it would be one more
 * place to fix when it moves. Each suite gets a database of its own — they all
 * truncate between tests, and vitest runs projects concurrently, so two on one
 * database clear each other's rows mid-test.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Setup runs before any reporter, so this is the only channel it has. */
const report = (message: string) => process.stdout.write(`${message}\n`)
const SERVER_URL = process.env.DATABASE_URL || 'postgresql://kukan:kukan@localhost:5432/kukan'

/**
 * The server from `DATABASE_URL`, with `name` as the database.
 *
 * One knob points every suite at a Postgres, and the name — which is what keeps
 * two suites off each other's rows — always applies.
 */
export function testDatabaseUrl(name: string): string {
  const url = new URL(SERVER_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/** Create the database if it is not there, then bring it up to date. */
export async function setupTestDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: SERVER_URL })
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${name}`)
      report(`Created database: ${name}`)
    }
  } finally {
    await admin.end()
  }

  const pool = new Pool({ connectionString: testDatabaseUrl(name) })
  try {
    // Ahead of the migrations, which assume it.
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    // From dist/ or src/, the migrations are two levels up either way.
    await migrate(drizzle(pool), { migrationsFolder: resolve(HERE, '../drizzle') })
    report(`Migrations complete: ${name}`)
  } finally {
    await pool.end()
  }
}
