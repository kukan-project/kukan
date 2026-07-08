/**
 * KUKAN System Setting Schema
 * Runtime-adjustable settings managed from the admin UI (ADR-036)
 */

import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core'

export const systemSetting = pgTable('system_setting', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 100 }).notNull().unique(),
  value: jsonb('value').notNull(),
  created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
  updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
})
