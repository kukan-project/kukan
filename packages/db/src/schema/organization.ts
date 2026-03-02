/**
 * KUKAN Organization Schema
 * CKAN-compatible organization table
 */

import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const organization = pgTable(
  'organization',
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
  (table) => [index('idx_organization_name').on(table.name), index('idx_organization_state').on(table.state)]
)
