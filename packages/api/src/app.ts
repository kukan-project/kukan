/**
 * KUKAN API Application
 * Hono app instance with middleware and routes
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { createLogger, loadEnv, ODATA_BASE_PATH } from '@kukan/shared'
import { createDb } from '@kukan/db'
import { PostgresJobQueue, httpWake } from '@kukan/queue'
import { createAdapters } from './adapters'
import { AnalyticsService } from './services/analytics-service'
import { createAuth } from './auth/auth'
import { isRegistrationAllowed } from './services/bootstrap'
import { SystemSettingService } from './services/system-setting'
import { optionalAuth } from './middleware/auth'
import { authSurface } from './middleware/auth-surface'
import { limitBody } from './middleware/body-limit'
import { cacheControl, noCache } from './middleware/cache-control'
import { errorHandler } from './middleware/error-handler'
import { logger } from './middleware/logger'
import { retireConnection } from './middleware/retire-connection'
import type { AppContext } from './context'

export async function createApp() {
  const app = new Hono<{ Variables: AppContext }>()

  // Load environment variables
  const env = loadEnv()

  // Initialize database
  const db = createDb(env.DATABASE_URL, {
    max: env.WEB_DB_POOL_MAX,
    idleTimeoutMillis: env.WEB_DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.WEB_DB_POOL_CONNECTION_TIMEOUT_MS,
  })

  // Initialize Better Auth
  const auth = createAuth(db)

  // Initialize adapters
  const baseLogger = createLogger({ name: 'api', level: env.LOG_LEVEL })
  const adapters = await createAdapters(env, db, baseLogger)

  // Job queue (ADR-058): jobs are rows, and the worker is told to look
  const queue = new PostgresJobQueue({
    db,
    notify: env.WORKER_WAKE_URL ? httpWake(env.WORKER_WAKE_URL, env.BETTER_AUTH_SECRET) : undefined,
    logger: baseLogger.child({ component: 'job-queue' }),
  })

  // GA4 Analytics (optional — null when env vars not set)
  const analytics =
    env.GA4_PROPERTY_ID && env.GA4_CLIENT_EMAIL && env.GA4_PRIVATE_KEY
      ? new AnalyticsService(env.GA4_PROPERTY_ID, env.GA4_CLIENT_EMAIL, env.GA4_PRIVATE_KEY)
      : null

  // Runtime settings (shared instance so the read cache spans requests)
  const settings = new SystemSettingService(db)

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

  // Request ID (must come before logger)
  app.use('*', requestId())

  // Set context variables
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('storage', adapters.storage)
    c.set('search', adapters.search)
    c.set('dbSearch', adapters.dbSearch)
    c.set('queue', queue)
    c.set('ai', adapters.ai)
    c.set('auth', auth)
    c.set('env', env)
    c.set('analytics', analytics)
    c.set('settings', settings)
    c.set('logger', baseLogger.child({ requestId: c.get('requestId') }))
    await next()
  })

  // Middleware
  app.use('*', logger)
  app.use('*', cacheControl)
  app.use('*', retireConnection)
  app.use('/api/*', limitBody)
  app.onError(errorHandler)

  // Health check
  app.get('/api/health', noCache(), (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Better Auth endpoints - handle all /api/auth/** routes
  // Must be registered BEFORE optionalAuth to avoid body stream consumption
  app.use('/api/auth/*', authSurface)
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    // Block self-registration when disabled — forced on while the user table
    // is empty so the first sign-up can bootstrap the instance (ADR-038)
    if (c.req.path.endsWith('/sign-up/email')) {
      if (!(await isRegistrationAllowed(db, settings))) {
        return c.json(
          {
            type: 'about:blank',
            title: 'FORBIDDEN',
            status: 403,
            detail: 'Self-registration is disabled',
          },
          403
        )
      }
    }
    return auth.handler(c.req.raw)
  })

  // OData feed for BI tools (ADR-055). Mounted ahead of the auth middleware on
  // purpose: it serves public resources only, so there is no session to resolve
  // and nothing per-request for it to carry.
  const { odataRouter } = await import('./routes/odata')
  app.route(ODATA_BASE_PATH, odataRouter)
  // How many pages it will read at once, and what that was derived from: the
  // number follows the memory this process has, so it differs between a laptop
  // and a 512 MB task and should not have to be guessed from either.
  const { capacity } = await import('./services/odata/capacity')
  // Loud where it read no limit: that is right on a host that sets none, and
  // oversized on a container whose limit it cannot see.
  baseLogger[capacity.source === 'host' ? 'warn' : 'info'](
    {
      component: 'odata',
      slots: capacity.slots,
      memoryMb: capacity.memoryMb,
      memorySource: capacity.source,
    },
    capacity.source === 'host'
      ? 'odata feed capacity from host memory; no container memory limit was found'
      : 'odata feed capacity'
  )

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
  const { apiTokensRouter } = await import('./routes/api-tokens')
  const { adminRouter } = await import('./routes/admin')
  const { announcementsRouter } = await import('./routes/announcements')
  const { siteRouter } = await import('./routes/site')

  apiV1.route('/organizations', organizationsRouter)
  apiV1.route('/packages', packagesRouter)
  apiV1.route('/resources', resourcesRouter)
  apiV1.route('/groups', groupsRouter)
  apiV1.route('/tags', tagsRouter)
  apiV1.route('/users', usersRouter)
  apiV1.route('/api-tokens', apiTokensRouter)
  apiV1.route('/admin', adminRouter)
  apiV1.route('/announcements', announcementsRouter)
  apiV1.route('/site', siteRouter)

  app.route('/api/v1', apiV1)

  // MCP server endpoint (Streamable HTTP)
  const { mcpRouter } = await import('./routes/mcp')
  app.route('/api/mcp', mcpRouter)

  // CKAN-compatible API routes — unversioned too, where ckanapi calls by default
  const { ckanCompatRouter } = await import('./routes/ckan-compat')
  app.route('/api/3/action', ckanCompatRouter)
  app.route('/api/action', ckanCompatRouter)

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

  return { app, logger: baseLogger }
}
