/**
 * KUKAN Database Migration Script
 * Run with: pnpm db:migrate
 */

import { config } from 'dotenv'
import { loadEnv } from '@kukan/shared'
import { runMigrations } from '../src/migrate'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const { DATABASE_URL } = loadEnv()

runMigrations(DATABASE_URL).catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
