/**
 * KUKAN API Context Type Extensions
 * Extends Hono context with custom properties
 */

import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Env, Logger } from '@kukan/shared'
import type { Auth } from './auth/auth'

export interface AppContext {
  db: Database
  storage: StorageAdapter
  search: SearchAdapter
  /** PostgreSQL-based search adapter for dashboard (always consistent with DB) */
  dbSearch: SearchAdapter
  queue: QueueAdapter
  ai: AIAdapter
  auth: Auth
  env: Env
  logger: Logger
  requestId: string
  // Better Auth session will be added by middleware
  user?: {
    id: string
    email: string
    name: string
    sysadmin: boolean
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    db: Database
    storage: StorageAdapter
    search: SearchAdapter
    /** PostgreSQL-based search adapter for dashboard (always consistent with DB) */
    dbSearch: SearchAdapter
    queue: QueueAdapter
    ai: AIAdapter
    auth: Auth
    env: Env
    logger: Logger
    requestId: string
    user?: {
      id: string
      email: string
      name: string
      sysadmin: boolean
    }
  }
}
