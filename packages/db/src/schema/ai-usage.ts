/**
 * KUKAN AI Usage Schema
 *
 * What AI calls consumed, and what they were spent on. One row per call,
 * except query embeddings: one is made per search, so they are summed per
 * process and quarter hour and written as one row (`calls` > 1, `occurred_at`
 * the quarter's start). Every total reads both kinds alike.
 *
 * The cost is the list price at the time of the call, kept with the row so a
 * rate changed later does not move a month already closed. A call with no
 * known rate adds to `unpriced_calls` instead, so a total can say what it
 * leaves out.
 */

import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'
import type { AiProvider, AiUsagePurpose } from '@kukan/shared'

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<AiProvider>().notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    purpose: varchar('purpose', { length: 40 }).$type<AiUsagePurpose>().notNull(),
    // No foreign key: the record outlives the resource, and a call that ends
    // as its resource is purged must still be written
    resourceId: uuid('resource_id'),
    calls: integer('calls').notNull().default(1),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).notNull().default(0),
    unpricedCalls: integer('unpriced_calls').notNull().default(0),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_ai_usage_occurred_at').on(table.occurredAt)]
)
