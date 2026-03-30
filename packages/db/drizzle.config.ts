import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { loadEnv } from '@kukan/shared'

config({ path: '../../.env' })

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: loadEnv().DATABASE_URL,
  },
})
