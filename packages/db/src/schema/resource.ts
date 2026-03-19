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
    position: integer('position').default(0).notNull(),
    state: varchar('state', { length: 20 }).default('active'),
    resourceType: varchar('resource_type', { length: 50 }),
    extras: jsonb('extras').$type<Record<string, unknown>>().default({}),

    // Storage information
    previewKey: text('preview_key'),

    // Ingest results
    ingestStatus: varchar('ingest_status', { length: 20 }).default('pending'),
    ingestError: text('ingest_error'),
    ingestMetadata: jsonb('ingest_metadata').$type<Record<string, unknown>>(),

    // AI analysis results
    aiSchema: jsonb('ai_schema').$type<Record<string, unknown>>(),
    piiCheck: jsonb('pii_check').$type<Record<string, unknown>>(),
    contentHash: text('content_hash'),

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
    index('idx_resource_ingest_status').on(table.ingestStatus),
    index('idx_resource_name_trgm').using('gin', table.name.op('gin_trgm_ops')),
    index('idx_resource_description_trgm').using('gin', table.description.op('gin_trgm_ops')),
  ]
)
