/**
 * KUKAN API Application
 * Hono app instance with middleware and routes
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { loadEnv } from '@kukan/shared'
import { createDb } from '@kukan/db'
import { createAdapters } from './adapters'
import { createAuth } from './auth/auth'
import { optionalAuth } from './middleware/auth'
import { errorHandler } from './middleware/error-handler'
import { logger } from './middleware/logger'
import type { AppContext } from './context'

export async function createApp() {
  const app = new Hono<{ Variables: AppContext }>()

  // Load environment variables
  const env = loadEnv()

  // Initialize database
  const db = createDb(env.DATABASE_URL)

  // Initialize Better Auth
  const auth = createAuth(db)

  // Initialize adapters
  const adapters = createAdapters(env)

  // Set context variables
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('storage', adapters.storage)
    c.set('search', adapters.search)
    c.set('queue', adapters.queue)
    c.set('ai', adapters.ai)
    c.set('env', env)
    await next()
  })

  // Middleware
  app.use('*', logger)
  app.use('*', cors())
  app.use('*', optionalAuth(auth))
  app.onError(errorHandler)

  // Health check
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Better Auth endpoints - handle all /api/auth/** routes
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) {
      console.log('[Better Auth] Handling request:', c.req.method, c.req.path)
      const response = await auth.handler(c.req.raw)
      console.log('[Better Auth] Response status:', response.status)
      return response
    }
    return next()
  })

  // API v1 routes
  const apiV1 = new Hono<{ Variables: AppContext }>()

  // Import and register routes
  const { organizationsRouter } = await import('./routes/organizations')
  const { packagesRouter } = await import('./routes/packages')
  const { resourcesRouter } = await import('./routes/resources')
  const { groupsRouter } = await import('./routes/groups')
  const { tagsRouter } = await import('./routes/tags')
  const { usersRouter } = await import('./routes/users')
  const { searchRouter } = await import('./routes/search')

  apiV1.route('/organizations', organizationsRouter)
  apiV1.route('/packages', packagesRouter)
  apiV1.route('/resources', resourcesRouter)
  apiV1.route('/groups', groupsRouter)
  apiV1.route('/tags', tagsRouter)
  apiV1.route('/users', usersRouter)
  apiV1.route('/search', searchRouter)

  app.route('/api/v1', apiV1)

  // CKAN-compatible API v3 routes
  const { ckanCompatRouter } = await import('./routes/ckan-compat')
  app.route('/api/3/action', ckanCompatRouter)

  // 404 handler
  app.notFound((c) => {
    return c.json(
      {
        type: 'about:blank',
        title: 'NOT_FOUND',
        status: 404,
        detail: 'The requested resource was not found',
      },
      404
    )
  })

  return app
}
