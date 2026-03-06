/**
 * KUKAN User Schema
 * Integrated with Better Auth user table
 */

import { pgTable, varchar, text, timestamp, boolean, index } from 'drizzle-orm/pg-core'

export const user = pgTable(
  'user',
  {
    // Better Auth required fields (using text ID for Better Auth compatibility)
    id: text('id').primaryKey(),
    email: varchar('email', { length: 200 }).unique().notNull(),
    emailVerified: boolean('emailVerified').default(false).notNull(),
    name: varchar('name', { length: 100 }).unique().notNull(),
    image: text('image'),

    // KUKAN-specific fields
    displayName: text('display_name'),
    state: varchar('state', { length: 20 }).default('active'),
    sysadmin: boolean('sysadmin').default(false).notNull(),

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
