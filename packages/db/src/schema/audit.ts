/**
 * KUKAN Audit Log Schema
 * Replacement for *_revision tables in CKAN
 */

import { pgTable, bigserial, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { user } from './user'

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    action: varchar('action', { length: 20 }).notNull(),
    userId: text('user_id').references(() => user.id),
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_audit_entity').on(table.entityType, table.entityId, table.createdAt)]
)
