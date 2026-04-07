/**
 * KUKAN API Server
 * Node.js HTTP server entry point
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { createApp } from './app'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const port = parseInt(process.env.PORT || '3000', 10)
const { app, logger: log } = await createApp()

log.info({ port }, 'KUKAN API Server starting')

serve({ fetch: app.fetch, port })

log.info({ port, url: `http://localhost:${port}` }, 'Server is running')
