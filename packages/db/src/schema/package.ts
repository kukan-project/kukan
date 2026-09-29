/**
 * KUKAN Package (Dataset) Schema
 * CKAN-compatible dataset/package table
 */

import { sql } from 'drizzle-orm'
import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { organization } from './organization'
import { user } from './user'

export const packageTable = pgTable(
  'package',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).unique().notNull(),
    title: text('title'),
    notes: text('notes'),
    url: text('url'),
    version: varchar('version', { length: 100 }),
    licenseId: varchar('license_id', { length: 100 }),
    author: text('author'),
    authorEmail: text('author_email'),
    maintainer: text('maintainer'),
    maintainerEmail: text('maintainer_email'),
    state: varchar('state', { length: 20 }).default('active'),
    type: varchar('type', { length: 100 }).default('dataset'),
    ownerOrg: uuid('owner_org').references(() => organization.id),
    private: boolean('private').default(false).notNull(),
    creatorUserId: text('creator_user_id').references(() => user.id),
    extras: jsonb('extras').$type<Record<string, unknown>>().default({}),

    // New feature fields (Phase 1: nullable, used in later phases)
    qualityScore: text('quality_score'), // Phase 4: change to FLOAT
    aiSummary: text('ai_summary'),
    aiTags: text('ai_tags'),

    // The vector lives on the resource, not here (ADR-054): a centroid of a
    // package's resources cannot answer which of nineteen sheets to open.

    // When this row, or a name its search document carries (its organization's,
    // its groups'), last changed in a way the document has not heard of — null
    // once it has. The resource's `docSyncDueAt` contract: set in the statement
    // that made them disagree, and the token the sync clears against.
    docSyncDueAt: timestamp('doc_sync_due_at', { withTimezone: true }),

    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_package_name').on(table.name),
    index('idx_package_owner_org').on(table.ownerOrg),
    index('idx_package_state').on(table.state),
    index('idx_package_creator_user_id').on(table.creatorUserId),
    // pg_trgm GIN indexes for ILIKE search acceleration (requires CREATE EXTENSION pg_trgm)
    index('idx_package_title_trgm').using('gin', table.title.op('gin_trgm_ops')),
    index('idx_package_notes_trgm').using('gin', table.notes.op('gin_trgm_ops')),
    index('idx_package_name_trgm').using('gin', table.name.op('gin_trgm_ops')),
    // Read by the document sync and its sweep, as the resource's is
    index('idx_package_doc_sync_due')
      .on(table.docSyncDueAt)
      .where(sql`${table.docSyncDueAt} IS NOT NULL`),
  ]
)
