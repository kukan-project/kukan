/**
 * KUKAN API Context Type Extensions
 * Extends Hono context with custom properties
 */

import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Env } from '@kukan/shared'

export interface AppContext {
  db: Database
  storage: StorageAdapter
  search: SearchAdapter
  queue: QueueAdapter
  ai: AIAdapter
  env: Env
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
    queue: QueueAdapter
    ai: AIAdapter
    env: Env
    user?: {
      id: string
      email: string
      name: string
      sysadmin: boolean
    }
  }
}
