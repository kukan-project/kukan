/**
 * KUKAN Activity Stream Schema
 * Activity feed for tracking user and system actions
 */

import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { user } from './user'

export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => user.id),
    objectId: uuid('object_id').notNull(),
    objectType: varchar('object_type', { length: 50 }).notNull(),
    activityType: varchar('activity_type', { length: 100 }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_activity_object').on(table.objectType, table.objectId, table.createdAt)]
)
