/**
 * KUKAN Membership Schema
 * user_org_membership, user_group_membership, package_group tables
 */

import { pgTable, uuid, varchar, timestamp, unique } from 'drizzle-orm/pg-core'
import { user } from './user'
import { organization } from './organization'
import { group } from './group'
import { packageTable } from './package'

export const userOrgMembership = pgTable(
  'user_org_membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 50 }).default('member').notNull(),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('uq_user_org').on(table.userId, table.organizationId)]
)

export const userGroupMembership = pgTable(
  'user_group_membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 50 }).default('member').notNull(),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('uq_user_group').on(table.userId, table.groupId)]
)

export const packageGroup = pgTable(
  'package_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packageTable.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
  },
  (table) => [unique('uq_package_group').on(table.packageId, table.groupId)]
)
