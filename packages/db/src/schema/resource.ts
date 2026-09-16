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
import { sql } from 'drizzle-orm'
import type { ColumnSettings, ResourceSummaryMeta } from '@kukan/shared'
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

/**
 * What the health checker carries between its runs, plus what it reports to
 * operators. Deliberately not called metadata: nothing here describes the
 * resource, and the column it was moved out of — `extras`, which CKAN defines
 * as caller-supplied metadata — is rendered whole on the public dataset page.
 *
 * `error` and `httpStatus` are read by the sysadmin health screen; the rest is
 * the checker talking to itself. Neither is public, so both live here and the
 * column stays off the public projection.
 */
export interface HealthCheckState {
  etag?: string
  lastModified?: string
  /** Null when the last check succeeded — the checker clears it explicitly. */
  error?: string | null
  httpStatus?: number
  /** Epoch ms. Absent reads as overdue, so a lost value re-fetches the body. */
  lastFullFetchAt?: number
}

/**
 * What the health checker called these before it had a column of its own.
 *
 * Migration 0035 took them off `extras`, but a deploy runs the new worker beside
 * the old one, and the old one writes them back — onto a column CKAN defines as
 * caller-supplied metadata, which every public read returns. Worse, it stamps
 * `healthCheckedAt` doing so, which puts the row outside the staleness window
 * the new worker selects on: the row would carry them, publicly, until it comes
 * round again a day later. So the checker's write takes them off, and so does
 * the public projection.
 *
 * Named rather than matched on `health%` so neither eats a key someone else
 * chose. Both go once nothing writes them: the old worker, or an `extras` opened
 * to callers, whichever comes first.
 */
export const LEGACY_HEALTH_EXTRAS_KEYS = [
  'healthEtag',
  'healthLastModified',
  'healthError',
  'healthHttpStatus',
  'healthLastFullFetchAt',
] as const

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
    // The heading this resource sits under (ADR-050): a run of adjacent rows
    // sharing a label, so nothing here constrains `position`. The public page
    // nests on `/` up to a fixed depth; the dashboard shows the whole path.
    section: text('section'),
    state: varchar('state', { length: 20 }).default('active'),
    resourceType: varchar('resource_type', { length: 50 }),
    // Caller-supplied metadata, as CKAN defines it, and rendered whole on the
    // public dataset page. Nothing internal goes here: the health checker did,
    // and every reader had to be taught to look away — see {@link
    // HealthCheckState}, which is what a column for internal state looks like.
    extras: jsonb('extras').$type<Record<string, unknown>>().default({}),
    // What a person settled about this resource's columns — the primary key
    // today, settled types in ii-c (ADR-043 layer 2, spec §6.2). Separate from
    // everything the interpretation infers, which a re-run rewrites; only a
    // person writes here, so the worker's metadata merges cannot reach it.
    // Applies to versions created from here on; each version freezes the value
    // it was created under.
    columnSettings: jsonb('column_settings').$type<ColumnSettings>().notNull().default({}),

    // The AI-written abstract and everything about it (ADR-053). An editor's
    // own text lives in the same column — `summaryMeta.source` says whose it
    // is, and generation never overwrites a person's.
    //
    // Two columns rather than eleven for the reason {@link HealthCheckState}
    // gives: nothing here is filtered on. Both the embedding assembly and the
    // public projection read the row first and decide afterwards. And as with
    // `extras`, what a reader may see is narrower than what is stored — see
    // `publicSummary`, the only place this becomes a response.
    summary: text('summary'),
    summaryMeta: jsonb('summary_meta').$type<ResourceSummaryMeta>().notNull().default({}),
    // When this row stopped agreeing with its search document, null once they
    // agree again (ADR-053 §9.3). Set in the *same statement* as the write that
    // made them disagree — separately, a crash between the two leaves a new
    // abstract with nothing recording that the index has not heard of it.
    //
    // It is also the token the sync clears against. A job reads this value
    // before writing the document and clears only that value, so an edit made
    // while it was working leaves a newer one behind and the row stays due —
    // a plain clear would drop a hide on the floor, leaving text somebody took
    // down answering searches until something else happened to that row.
    //
    // The queue owns the retry; this owns the case where the queue never heard.
    docSyncDueAt: timestamp('doc_sync_due_at', { withTimezone: true }),

    // Quality Monitor. All three describe `(url, url_type)` and nothing else:
    // the verdict, when it was reached, and the validators it was reached from.
    // A writer that changes either URL column resets all three — a verdict kept
    // across that change condemns the new address for the old one's failure,
    // and the checker only revisits a row a day later.
    healthStatus: varchar('health_status', { length: 20 }).default('unknown'),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    healthCheckState: jsonb('health_check_state').$type<HealthCheckState>().default({}),
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
    // Read by the document sweep, which asks for the rows that are due.
    // Partial: the rows that agree are the overwhelming majority, and they are
    // exactly the ones it never wants.
    index('idx_resource_doc_sync_due')
      .on(table.docSyncDueAt)
      .where(sql`${table.docSyncDueAt} IS NOT NULL`),
  ]
)

/**
 * `extras` with {@link LEGACY_HEALTH_EXTRAS_KEYS} taken off — the scrub, spelled
 * once. Both the public projection and the checker's own write apply it, and
 * both go together, so neither owns it.
 */
export const scrubbedExtras = sql<
  Record<string, unknown>
>`COALESCE(${resource.extras}, '{}'::jsonb) - ${sql.param(LEGACY_HEALTH_EXTRAS_KEYS)}::text[]`

/**
 * The parts of `summary_meta` a reader may see (ADR-053 §4.1).
 *
 * The rest is the worker talking to itself: the generation it compares against,
 * the token count a refusal reported, and which model wrote this one. Taken off
 * here, in the projection, for the reason {@link scrubbedExtras} is — an
 * endpoint cannot leak them by forgetting, and the next field added to the
 * object is private until someone decides otherwise.
 */
export const PRIVATE_SUMMARY_META_KEYS = [
  'genKey',
  'rejectedTokens',
  'model',
  'grounded',
  // Written by earlier generations; unread now, and still not public
  'hash',
  'materialHash',
] as const

export const publicSummaryMeta = sql<
  Record<string, unknown>
>`COALESCE(${resource.summaryMeta}, '{}'::jsonb) - ${sql.param(PRIVATE_SUMMARY_META_KEYS)}::text[]`

/**
 * The abstract as a reader may see it: absent once an editor hides it.
 *
 * Hidden is one decision with three effects — off the page, out of the
 * embedding, and not regenerated — and this is the first of them. Spelled in
 * the projection rather than checked per route for the same reason: a response
 * that forgets is a response that publishes text someone took down.
 */
export const publicSummary = sql<
  string | null
>`CASE WHEN ${resource.summaryMeta}->>'hidden' = 'true' THEN NULL ELSE ${resource.summary} END`
