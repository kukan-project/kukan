/**
 * KUKAN API Token Schema
 * API key authentication tokens
 */

import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core'
import { user } from './user'

export const apiToken = pgTable(
  'api_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }),
    tokenHash: text('token_hash').notNull(),
    lastUsed: timestamp('last_used', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_api_token_token_hash').on(table.tokenHash),
    index('idx_api_token_user_id').on(table.userId),
  ]
)
