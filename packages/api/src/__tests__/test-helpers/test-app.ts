/**
 * Test app factory for integration tests.
 *
 * Creates a Hono app with real DB but bypasses Better Auth and adapter initialization.
 * Routes are mounted manually so each test file can pick which routes to test.
 */
import { vi } from 'vitest'
import { Hono } from 'hono'
import type { Database } from '@kukan/db'
import { NoOpAIAdapter } from '@kukan/ai-adapter'
import { PostgresSearchAdapter, type SearchAdapter } from '@kukan/search-adapter'
import { errorHandler } from '../../middleware/error-handler'
import { createLogger, type Env } from '@kukan/shared'
import type { Auth } from '../../auth/auth'

import { packagesRouter } from '../../routes/packages'
import { organizationsRouter } from '../../routes/organizations'
import { groupsRouter } from '../../routes/groups'
import { tagsRouter } from '../../routes/tags'
import { resourcesRouter } from '../../routes/resources'
import { searchRouter } from '../../routes/search'
import { adminRouter } from '../../routes/admin'
import { ckanCompatRouter } from '../../routes/ckan-compat'

// Minimal mock adapters (search/storage are no-ops for route tests)
const mockSearch: SearchAdapter = {
  search: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  index: async () => {},
  delete: async () => {},
  bulkIndex: async () => {},
  deleteAll: async () => {},
  sumResourceCount: async () => 0,
}

const mockStorage = {
  upload: async () => {},
  download: async () => {
    throw new Error('not implemented in test')
  },
  downloadRange: async () => {
    throw new Error('not implemented in test')
  },
  delete: async () => {},
  deleteByPrefix: async () => 0,
  getSignedUrl: async () => 'file:///test',
  getSignedUploadUrl: async () => 'https://minio.test/upload?signed=true',
}

const mockQueue = {
  enqueue: vi.fn().mockResolvedValue('mock-job-id'),
  getStats: vi.fn().mockResolvedValue({ pending: 0, inFlight: 0, delayed: 0 }),
  process: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
}
const mockAi = new NoOpAIAdapter()

const mockAuth = {
  api: {
    createUser: vi
      .fn()
      .mockResolvedValue({ id: 'new-user-id', name: 'created', email: 'created@example.com' }),
  },
} as unknown as Auth

const testEnv = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://kukan:kukan@localhost:5432/kukan_test',
  SEARCH_TYPE: 'postgres',
  OPENSEARCH_URL: 'http://localhost:9200',
  SQS_QUEUE_URL: 'http://localhost:9324/000000000000/kukan-pipeline',
  AI_TYPE: 'none',
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
} as unknown as Env

/** Default sysadmin user for tests. Set `user: null` to test unauthenticated access. */
const defaultTestUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test-admin@example.com',
  name: 'test-admin',
  displayName: null,
  sysadmin: true,
}

interface TestAppOverrides {
  search?: SearchAdapter
  /** Override the authenticated user. Pass `null` for unauthenticated. */
  user?: {
    id: string
    email: string
    name: string
    displayName?: string | null
    sysadmin: boolean
  } | null
  /** Override the auth instance (for testing admin user creation). */
  auth?: Auth
}

export function createTestApp(db: Database, overrides?: TestAppOverrides) {
  const app = new Hono()

  const testUser = overrides?.user === null ? undefined : (overrides?.user ?? defaultTestUser)

  const testLogger = createLogger({ name: 'test', level: 'silent' })

  // Inject context
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('search', overrides?.search ?? mockSearch)
    c.set('dbSearch', new PostgresSearchAdapter(db))
    c.set('storage', mockStorage)
    c.set('queue', mockQueue)
    c.set('ai', mockAi)
    c.set('auth', overrides?.auth ?? mockAuth)
    c.set('env', testEnv)
    c.set('logger', testLogger)
    c.set('requestId', 'test-request-id')
    if (testUser) c.set('user', { displayName: null, ...testUser })
    await next()
  })

  app.onError(errorHandler)

  // Health check
  app.get('/api/health', (c) => {
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
  apiV1.route('/admin', adminRouter)
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
