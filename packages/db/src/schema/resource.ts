/**
 * KUKAN Resource Schema
 * CKAN-compatible resource table with extended fields
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import { packageTable } from './package'

/**
 * The columns a replacement upload will set, held until it is promoted
 * (ADR-043). Exactly the fields `prepareForUpload` derives from the request.
 */
export interface PendingResourceMetadata {
  url: string
  urlType: string
  name: string
  format: string | null
  mimetype: string
}

export const resource = pgTable(
  'resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packageTable.id, { onDelete: 'cascade' }),
    url: text('url'),
    urlType: varchar('url_type', { length: 20 }),
    name: text('name'),
    description: text('description'),
    format: varchar('format', { length: 100 }),
    mimetype: varchar('mimetype', { length: 200 }),
    size: bigint('size', { mode: 'number' }),
    hash: text('hash'),

    // Which object holds the content, null when none is stored (ADR-043).
    // 0009 dropped a column of this name as derivable; per-run keys removed
    // that property, so it is state again.
    storageKey: text('storage_key'),
    // Content generation, re-minted by every writer of the pointer above. What
    // a revert compares against to refuse retracting content its caller never
    // saw (ADR-044 §4). Not a version number, because content can be live with
    // no version holding it — an upload no run has created yet.
    contentRevision: uuid('content_revision').notNull().defaultRandom(),
    // Key a presigned upload was issued for, promoted by `upload-complete` —
    // separate so the live object keeps serving an abandoned upload. The
    // timestamp is what lets the sweep reclaim one that never completed.
    pendingStorageKey: text('pending_storage_key'),
    pendingStorageKeyAt: timestamp('pending_storage_key_at', { withTimezone: true }),
    // What the replacement will be called and how it is typed. Held here rather
    // than applied straight away, so an abandoned upload leaves the resource
    // describing the content it is still serving, not the one that never
    // arrived. Applied to the columns above when the upload is promoted.
    pendingMetadata: jsonb('pending_metadata').$type<PendingResourceMetadata>(),
    position: integer('position').default(0).notNull(),
    state: varchar('state', { length: 20 }).default('active'),
    resourceType: varchar('resource_type', { length: 50 }),
    extras: jsonb('extras').$type<Record<string, unknown>>().default({}),

    // Quality Monitor
    healthStatus: varchar('health_status', { length: 20 }).default('unknown'),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    qualityIssues: jsonb('quality_issues').$type<unknown[]>().default([]),

    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
    lastModified: timestamp('last_modified', { withTimezone: true }),
  },
  (table) => [
    index('idx_resource_package').on(table.packageId),
    index('idx_resource_format').on(table.format),
    index('idx_resource_name_trgm').using('gin', table.name.op('gin_trgm_ops')),
    index('idx_resource_description_trgm').using('gin', table.description.op('gin_trgm_ops')),
    index('idx_resource_health_check').on(table.urlType, table.state, table.healthCheckedAt),
    // Read by the orphan sweep, which asks whether any pointer still names a
    // key before deleting its object (ADR-045 §3). Unindexed it would scan
    // this table once per swept key, hourly.
    index('idx_resource_storage_key').on(table.storageKey),
    index('idx_resource_pending_storage_key').on(table.pendingStorageKey),
  ]
)
