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
    // versions/{packageId}/{resourceId}/v{n}.{attempt} — the token is per write,
    // so a retried capture never reuses a key the orphan sweep is deciding about
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }),
    hash: text('hash'),
    // 'upload' = explicit replacement, 'fetch' = observed at fetch time (external URL).
    origin: varchar('origin', { length: 10 }).notNull(),
    // The format the resource carried at capture — the condition this version's
    // interpretation is made under (ADR-046 §6). Held here because the
    // resource's label is user-editable, and reading the current one would
    // interpret settled bytes by a rule never applied to them.
    format: varchar('format', { length: 100 }),
    // active → purging → purged (ADR-028 durable-claim pattern).
    state: varchar('state', { length: 10 }).notNull().default('active'),
    // Column schema snapshot for this version (ADR-032 shape); null for
    // non-tabular formats or when the interpretation produced none.
    schema: jsonb('schema').$type<ResourceSchema | null>(),
    // DuckLake snapshot this tabular version maps to (ADR-043 layer 2 / Phase ii).
    // Null for non-tabular versions or before layer-2 ingest; nulled on purge.
    ducklakeSnapshotId: bigint('ducklake_snapshot_id', { mode: 'number' }),
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
    // Drives the dashboard's pending-ingest count. Partial, but no longer
    // near-empty: a version of a non-tabular resource never gets a snapshot, so
    // it stays in here for good and the pending query filters it out by format
    // (ADR-046). Worth an expression index on `lower(format)` if the count
    // starts costing anything.
    index('idx_resource_version_pending_lake')
      .on(table.resourceId, table.version)
      .where(sql`${table.state} = 'active' AND ${table.ducklakeSnapshotId} IS NULL`),
  ]
)
