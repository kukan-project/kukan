/**
 * Test app factory for integration tests.
 *
 * Creates a Hono app with real DB but bypasses Better Auth and adapter initialization.
 * Routes are mounted manually so each test file can pick which routes to test.
 */
import { Hono } from 'hono'
import type { Database } from '@kukan/db'
import { InProcessQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import { errorHandler } from '../../middleware/error-handler'
import type { Env } from '@kukan/shared'

import { packagesRouter } from '../../routes/packages'
import { organizationsRouter } from '../../routes/organizations'
import { groupsRouter } from '../../routes/groups'
import { tagsRouter } from '../../routes/tags'
import { resourcesRouter } from '../../routes/resources'
import { searchRouter } from '../../routes/search'
import { ckanCompatRouter } from '../../routes/ckan-compat'

// Minimal mock adapters (search/storage are no-ops for route tests)
const mockSearch: SearchAdapter = {
  search: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  index: async () => {},
  delete: async () => {},
  bulkIndex: async () => {},
}

const mockStorage = {
  upload: async () => {},
  download: async () => {
    throw new Error('not implemented in test')
  },
  delete: async () => {},
  getSignedUrl: async () => 'file:///test',
}

const mockQueue = new InProcessQueueAdapter()
const mockAi = new NoOpAIAdapter()

const testEnv = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://kukan:kukan@localhost:5432/kukan_test',
  STORAGE_TYPE: 'local',
  SEARCH_TYPE: 'postgres',
  QUEUE_TYPE: 'in-process',
  AI_TYPE: 'none',
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
} as unknown as Env

interface TestAppOverrides {
  search?: SearchAdapter
}

export function createTestApp(db: Database, overrides?: TestAppOverrides) {
  const app = new Hono()

  // Inject context
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('search', overrides?.search ?? mockSearch)
    c.set('storage', mockStorage)
    c.set('queue', mockQueue)
    c.set('ai', mockAi)
    c.set('env', testEnv)
    await next()
  })

  app.onError(errorHandler)

  // Health check
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Mount API v1 routes
  const apiV1 = new Hono()
  apiV1.route('/organizations', organizationsRouter)
  apiV1.route('/packages', packagesRouter)
  apiV1.route('/resources', resourcesRouter)
  apiV1.route('/groups', groupsRouter)
  apiV1.route('/tags', tagsRouter)
  apiV1.route('/search', searchRouter)
  app.route('/api/v1', apiV1)

  // CKAN compat
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
