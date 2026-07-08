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
import type { AnalyticsService } from './services/analytics-service'
import type { SystemSettingService } from './services/system-setting'

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
  /** GA4 analytics service (null when GA4 env vars not set) */
  analytics: AnalyticsService | null
  /** DB-backed runtime settings (ADR-036) */
  settings: SystemSettingService
  // Better Auth session will be added by middleware
  user?: {
    id: string
    email: string
    name: string
    displayName: string | null
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
    /** GA4 analytics service (null when GA4 env vars not set) */
    analytics: AnalyticsService | null
    /** DB-backed runtime settings (ADR-036) */
    settings: SystemSettingService
    user?: {
      id: string
      email: string
      name: string
      displayName: string | null
      sysadmin: boolean
    }
  }
}
