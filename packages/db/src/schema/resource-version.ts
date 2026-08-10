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
import type { NoTableReason, ResourceSchema } from '@kukan/shared'
import { resource } from './resource'
import { user } from './user'

export const resourceVersion = pgTable(
  'resource_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    // Sequential per resource, assigned at creation time (max + 1).
    version: integer('version').notNull(),
    // The object this version owns, and the only version that may delete it
    // (ADR-046 §3). Usually the live key the content arrived under, which the
    // version takes when nothing else owns it (ADR-043 §1); a copy when the
    // object was already owned, which is what an interpretation change over
    // content that did not move produces.
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }),
    hash: text('hash'),
    // 'upload' = explicit replacement, 'fetch' = observed at fetch time (external URL).
    origin: varchar('origin', { length: 10 }).notNull(),
    // The format the resource carried at creation — the condition this version's
    // interpretation is made under (ADR-046 §6). Held here because the
    // resource's label is user-editable, and reading the current one would
    // interpret settled bytes by a rule never applied to them.
    format: varchar('format', { length: 100 }),
    // active → purging → purged (ADR-028 durable-claim pattern), plus
    // `superseded`: content a revert stepped off. It stays in the history and
    // can still be purged, but it is not the live content and never becomes it
    // again, which is what keeps "the live content is the highest active
    // version" true across a revert (ADR-044 §4).
    state: varchar('state', { length: 20 }).notNull().default('active'),
    // Column schema snapshot for this version (ADR-032 shape); null for
    // non-tabular formats or when the interpretation produced none.
    schema: jsonb('schema').$type<ResourceSchema | null>(),
    // Why an interpretation produced no table, when it produced none. The empty
    // schema says "interpreted, nothing to load" and stops there; this says
    // which nothing, which is what someone asking "why is there no preview?"
    // is after. Null whenever a table *was* produced (ADR-046).
    noTableReason: varchar('no_table_reason', { length: 32 }).$type<NoTableReason | null>(),
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
    // At most one purge in flight per resource. A live purge restores the
    // pointer, moves layer 2 and asks for a rebuild, all naming a version
    // another purge could be taking away underneath them — and the rebuild
    // copies content on its way out into a version that purge will not
    // recognise. Enforced here so that nothing sets the state without meeting
    // it.
    uniqueIndex('idx_resource_version_one_purging')
      .on(table.resourceId)
      .where(sql`${table.state} = 'purging'`),
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
