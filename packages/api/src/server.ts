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

console.log(`🚀 KUKAN API Server starting on port ${port}`)

const app = await createApp()

serve({
  fetch: app.fetch,
  port,
})

console.log(`✅ Server is running at http://localhost:${port}`)
console.log(`📊 Health check: http://localhost:${port}/api/health`)
console.log(`📁 Organizations API: http://localhost:${port}/api/v1/organizations`)
console.log(`📦 Packages API: http://localhost:${port}/api/v1/packages`)
console.log(`📄 Resources API: http://localhost:${port}/api/v1/resources`)
console.log(`👥 Groups API: http://localhost:${port}/api/v1/groups`)
console.log(`🏷️  Tags API: http://localhost:${port}/api/v1/tags`)
console.log(`👤 Users API: http://localhost:${port}/api/v1/users`)
console.log(`🔍 Search API: http://localhost:${port}/api/v1/search`)
console.log(`🔌 CKAN-compatible API: http://localhost:${port}/api/3/action/*`)
