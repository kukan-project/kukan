/**
 * KUKAN Database Migration Script
 * Run with: pnpm db:migrate
 */

import { config } from 'dotenv'
import { runMigrations } from '../src/migrate'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required')
}

runMigrations(connectionString).catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
