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
  const adapters = await createAdapters(env, db)

  // Register queue handlers
  const { registerPipelineHandler } = await import('./queue/pipeline-handler')
  await registerPipelineHandler(db, adapters.queue, adapters.storage, adapters.search)

  // CORS — enabled when TRUSTED_ORIGINS is set (standalone / cross-origin access)
  const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(',').filter(Boolean)
  if (trustedOrigins?.length) {
    app.use(
      '/api/*',
      cors({
        origin: trustedOrigins,
        credentials: true,
      })
    )
  }

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
  app.onError(errorHandler)

  // Health check
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Better Auth endpoints - handle all /api/auth/** routes
  // Must be registered BEFORE optionalAuth to avoid body stream consumption
  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    return auth.handler(c.req.raw)
  })

  // Auth middleware for non-auth routes
  app.use('*', optionalAuth(auth))

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
  const { apiTokensRouter } = await import('./routes/api-tokens')

  apiV1.route('/organizations', organizationsRouter)
  apiV1.route('/packages', packagesRouter)
  apiV1.route('/resources', resourcesRouter)
  apiV1.route('/groups', groupsRouter)
  apiV1.route('/tags', tagsRouter)
  apiV1.route('/users', usersRouter)
  apiV1.route('/search', searchRouter)
  apiV1.route('/api-tokens', apiTokensRouter)

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
