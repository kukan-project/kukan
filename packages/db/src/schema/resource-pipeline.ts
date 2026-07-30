/**
 * KUKAN Resource Pipeline Schema
 * Tracks pipeline processing state separately from resource metadata
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { resource } from './resource'

export const resourcePipeline = pgTable(
  'resource_pipeline',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    // Which run owns this resource right now (ADR-044). Null when none does.
    // Recorded rather than inferred from `status` so a run that was taken over
    // can tell: without it, its final write would release the claim of whoever
    // displaced it, and it would never learn it had lost.
    claimOwner: uuid('claim_owner'),
    // When it was taken. Liveness is judged from this and the newest step
    // start, never from `updated` — that column is also written by enqueue and
    // by purge's preview invalidation, neither of which holds the claim, so a
    // user re-uploading would keep extending a dead run's window.
    claimOwnerAt: timestamp('claim_owner_at', { withTimezone: true }),
    error: text('error'),
    previewKey: text('preview_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_resource_pipeline_resource_id').on(table.resourceId),
    index('idx_resource_pipeline_status').on(table.status),
    index('idx_resource_pipeline_preview_key').on(table.previewKey),
    // The one storage pointer that lives inside JSON rather than in a column.
    // The orphan sweep asks whether any pointer still references a key before
    // deleting its object (ADR-045 §3), and this is the only one it could not
    // answer on an index.
    index('idx_resource_pipeline_text_head').on(sql`(${table.metadata} ->> 'textHeadKey')`),
  ]
)

export const resourcePipelineStep = pgTable(
  'resource_pipeline_step',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => resourcePipeline.id, { onDelete: 'cascade' }),
    stepName: varchar('step_name', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('idx_pipeline_step_pipeline_id').on(table.pipelineId)]
)
