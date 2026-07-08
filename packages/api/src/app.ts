/**
 * KUKAN API Application
 * Hono app instance with middleware and routes
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { createLogger, loadEnv } from '@kukan/shared'
import { createDb } from '@kukan/db'
import { createAdapters } from './adapters'
import { AnalyticsService } from './services/analytics-service'
import { createAuth } from './auth/auth'
import { SystemSettingService } from './services/system-setting'
import { optionalAuth } from './middleware/auth'
import { cacheControl, noCache } from './middleware/cache-control'
import { errorHandler } from './middleware/error-handler'
import { logger } from './middleware/logger'
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
    c.set('queue', adapters.queue)
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
  app.onError(errorHandler)

  // Health check
  app.get('/api/health', noCache(), (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Better Auth endpoints - handle all /api/auth/** routes
  // Must be registered BEFORE optionalAuth to avoid body stream consumption
  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    // Block self-registration when disabled
    if (!env.REGISTRATION_ENABLED && c.req.path.endsWith('/sign-up/email')) {
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
    // Disable the Better Auth admin-plugin HTTP endpoints (impersonate-user,
    // ban-user, set-role, set-user-password, list-users, remove-user, ...).
    // KUKAN manages users, roles, and account lifecycle through its own
    // /api/v1/admin API; these endpoints are unused and would otherwise let a
    // compromised sysadmin session impersonate any user or reset passwords with
    // no audit trail. The admin plugin stays configured for its schema fields
    // (role/banned) and defaultRole — only the routes are blocked. Respond 404
    // so the surface is not advertised.
    if (c.req.path.startsWith('/api/auth/admin/')) {
      return c.json(
        {
          type: 'about:blank',
          title: 'NOT_FOUND',
          status: 404,
          detail: 'The requested resource was not found',
        },
        404
      )
    }
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

  return { app, logger: baseLogger }
}
