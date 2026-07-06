/**
 * KUKAN Package (Dataset) Schema
 * CKAN-compatible dataset/package table
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core'
import { organization } from './organization'
import { user } from './user'

/** pgvector column without a fixed dimension so the embedding model or its
 *  dimension can change without DDL — consistency is enforced via the
 *  embedding_model key (model@dimension) at query time (ADR-034) */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector'
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value)
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[]
  },
})

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

    // Semantic search embedding (Phase 5a, ADR-034). No HNSW/IVFFlat index —
    // v1 uses exact search at package-metadata scale.
    embedding: vector('embedding'),
    // Vector-space key (model@dimension, see embeddingKey) — search filters on
    // this so vectors from other models/dimensions are never compared.
    embeddingModel: text('embedding_model'),
    embeddingHash: text('embedding_hash'),

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
  ]
)
