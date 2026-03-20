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
import { resource } from './resource'

export const resourcePipeline = pgTable(
  'resource_pipeline',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    error: text('error'),
    contentHash: text('content_hash'),
    previewKey: text('preview_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_resource_pipeline_resource_id').on(table.resourceId),
    index('idx_resource_pipeline_status').on(table.status),
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
