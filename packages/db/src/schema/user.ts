/**
 * KUKAN User Schema
 * Integrated with Better Auth user table + admin plugin
 */

import { pgTable, varchar, text, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core'

export const user = pgTable(
  'user',
  {
    // Better Auth required fields (using text ID for Better Auth compatibility)
    id: text('id').primaryKey(),
    email: varchar('email', { length: 200 }).unique().notNull(),
    emailVerified: boolean('emailVerified').default(false).notNull(),
    name: varchar('name', { length: 100 }).unique().notNull(),
    image: text('image'),

    // Better Auth admin plugin fields
    role: varchar('role', { length: 20 }).default('user'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: integer('ban_expires'),

    // KUKAN-specific fields
    displayName: text('display_name'),
    state: varchar('state', { length: 20 }).default('active'),

    // Timestamps
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_user_email').on(table.email),
    index('idx_user_name').on(table.name),
    index('idx_user_state').on(table.state),
  ]
)
