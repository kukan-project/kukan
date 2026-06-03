/**
 * KUKAN Announcement Schema
 * News/announcements displayed on the top page
 */

import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core'

export const announcement = pgTable(
  'announcement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    category: varchar('category', { length: 20 }).notNull().default('info'),
    link: text('link'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_announcement_published_at').on(table.publishedAt)]
)
