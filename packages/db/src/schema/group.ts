/**
 * KUKAN Group Schema
 * CKAN-compatible group table (separated from organization)
 */

import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const group = pgTable(
  'group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).unique().notNull(),
    title: text('title'),
    description: text('description'),
    imageUrl: text('image_url'),
    state: varchar('state', { length: 20 }).default('active'),
    extras: jsonb('extras').$type<Record<string, unknown>>().default({}),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_group_name').on(table.name), index('idx_group_state').on(table.state)]
)
