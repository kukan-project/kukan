/**
 * Better Auth Required Tables
 * session, account, verification tables for Better Auth + admin plugin
 */

import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { user } from './user'

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  // Better Auth admin plugin field
  impersonatedBy: text('impersonatedBy'),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow().notNull(),
})

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Better Auth identity key: (issuer, accountId). Credential accounts hold
    // the synthetic issuer 'local:credential'; providerId stays as the local
    // provider-configuration label.
    issuer: text('issuer').notNull(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('account_issuer_accountId_uidx').on(table.issuer, table.accountId),
    index('idx_account_userId').on(table.userId),
  ]
)

export const verification = pgTable('verification', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow().notNull(),
})
