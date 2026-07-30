/**
 * KUKAN Resource Version Schema
 * Immutable per-version snapshots of a resource's canonical file (ADR-043, layer 1).
 * Applies to all formats; row-level diff (layer 2, DuckLake) is added separately.
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
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { ResourceSchema } from '@kukan/shared'
import { resource } from './resource'
import { user } from './user'

export const resourceVersion = pgTable(
  'resource_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    // Sequential per resource, assigned at capture time (max + 1).
    version: integer('version').notNull(),
    // versions/{packageId}/{resourceId}/v{n}
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }),
    hash: text('hash'),
    // 'upload' = explicit replacement, 'fetch' = observed at fetch time (external URL).
    origin: varchar('origin', { length: 10 }).notNull(),
    // active → purging → purged (ADR-028 durable-claim pattern).
    state: varchar('state', { length: 10 }).notNull().default('active'),
    // Column schema snapshot for this version (ADR-032 shape); null for
    // non-tabular formats or when Extract produced none.
    schema: jsonb('schema').$type<ResourceSchema | null>(),
    // DuckLake snapshot this tabular version maps to (ADR-043 layer 2 / Phase ii).
    // Null for non-tabular versions or before layer-2 ingest; nulled on purge.
    ducklakeSnapshotId: bigint('ducklake_snapshot_id', { mode: 'number' }),
    // The preview Parquet this version still has to be ingested from, when its
    // ingest was deferred (ADR-043 §6-6). Set when the Lake step gives up and
    // queues a retry, cleared when the snapshot above lands.
    //
    // A pointer rather than a deadline: the retry carries the key in a queue
    // message, which the orphan sweep cannot see, and without this the run that
    // replaces the preview parks it and the sweep takes it — leaving a version
    // that can never enter layer 2. Named here, the sweep's reference check
    // finds it (ADR-045 §3), and the version is recoverable from the database
    // whether or not the message survived.
    lakeSourceKey: text('lake_source_key'),
    // Purge audit trail, retained on the tombstone row after content is destroyed.
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    purgedBy: text('purged_by').references(() => user.id),
    purgeReason: text('purge_reason'),
    createdBy: text('created_by').references(() => user.id),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_resource_version_res_ver').on(table.resourceId, table.version),
    index('idx_resource_version_state').on(table.state),
    // As above: the orphan sweep's reference check reads this column.
    index('idx_resource_version_storage_key').on(table.storageKey),
    // As above: the orphan sweep's reference check reads this column too.
    // Partial, like the one below and for the same reason: it is null for all
    // but the handful of versions waiting on an ingest, and `= o.key` never
    // matches a null anyway.
    index('idx_resource_version_lake_source_key')
      .on(table.lakeSourceKey)
      .where(sql`${table.lakeSourceKey} IS NOT NULL`),
    // Drives the dashboard's pending-ingest count; partial, so once the
    // migration is done it is empty and proving that costs nothing.
    index('idx_resource_version_pending_lake')
      .on(table.resourceId, table.version)
      .where(sql`${table.state} = 'active' AND ${table.ducklakeSnapshotId} IS NULL`),
  ]
)
