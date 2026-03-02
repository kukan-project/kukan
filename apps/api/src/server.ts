/**
 * KUKAN API Server
 * Node.js HTTP server entry point
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { createApp } from './app'

// Load .env file
config()

const app = createApp()
const port = parseInt(process.env.PORT || '3000', 10)

console.log(`🚀 KUKAN API Server starting on port ${port}`)

serve({
  fetch: app.fetch,
  port,
})

console.log(`✅ Server is running at http://localhost:${port}`)
console.log(`📊 Health check: http://localhost:${port}/health`)
