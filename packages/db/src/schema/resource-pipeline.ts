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
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { TableProfile } from '@kukan/shared'
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
    // What holds it: a pipeline run, or a job that merely needs runs kept away
    // (a purge, the backfill, a lake retry). Null when nothing holds it. Only a
    // run can be cancelled — a user replacing the content stops the processing
    // of it, and must not release the claim a purge is working under.
    claimKind: varchar('claim_kind', { length: 10 }).$type<'run' | 'job'>(),
    // When it was taken. Liveness is judged from this and the newest step
    // start, never from `updated` — that column is also written by enqueue and
    // by purge's preview invalidation, neither of which holds the claim, so a
    // user re-uploading would keep extending a dead run's window.
    claimOwnerAt: timestamp('claim_owner_at', { withTimezone: true }),
    error: text('error'),
    previewKey: text('preview_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    // The live version's table profile (ADR-063): column roles, the head of
    // the value lists, and the artifact the index is built from. Apart from
    // `metadata` because only the pages and tools that show it read it, and a
    // profile's lists would otherwise ride along on every read of the row.
    profile: jsonb('profile').$type<TableProfile>(),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_resource_pipeline_resource_id').on(table.resourceId),
    index('idx_resource_pipeline_status').on(table.status),
    index('idx_resource_pipeline_preview_key').on(table.previewKey),
    // The storage pointers that live inside JSON rather than in a column. The
    // orphan sweep asks whether any pointer still references a key before
    // deleting its object (ADR-045 §3), and these are the ones it could not
    // answer on an index otherwise.
    index('idx_resource_pipeline_text_head').on(sql`(${table.metadata} ->> 'textHeadKey')`),
    index('idx_resource_pipeline_document_text').on(sql`(${table.metadata} ->> 'documentTextKey')`),
    index('idx_resource_pipeline_profile_key').on(sql`(${table.profile} ->> 'key')`),
  ]
)

/**
 * Where a pipeline row names a storage key: a column of its own, or a field
 * of a jsonb column. `whole` marks a jsonb column that describes the key's
 * object and nothing else — a table profile and its artifact — so that
 * clearing the pointer clears the column.
 */
interface PipelinePointer {
  column: string
  field?: string
  whole?: true
}

/**
 * Every storage key a pipeline row names. The one list of them: the orphan
 * sweep asks it before deleting an object (ADR-045 §3), a writer that replaces
 * the row parks whatever it names, and retracting content clears and destroys
 * them (ADR-043 §5). A pointer missing from here is an object the sweep
 * deletes out from under its row, or an extract a purge leaves readable, so a
 * new one is added here and nowhere else.
 */
const PIPELINE_POINTERS: readonly PipelinePointer[] = [
  { column: 'preview_key' },
  // No longer written: the text head is read from the document's text. Rows
  // from before still name one, and interpreting them again parks it.
  { column: 'metadata', field: 'textHeadKey' },
  { column: 'metadata', field: 'documentTextKey' },
  { column: 'profile', field: 'key', whole: true },
]

function pointerExpression({ column, field }: PipelinePointer, alias?: string): string {
  const qualified = alias ? `${alias}.${column}` : column
  return field ? `(${qualified} ->> '${field}')` : qualified
}

/** Every storage key a pipeline row names, as SQL over the row under `alias`, in one order. */
export function pipelineObjectKeys(alias: string): SQL[] {
  return PIPELINE_POINTERS.map((pointer) => sql.raw(pointerExpression(pointer, alias)))
}

/**
 * The SET assignments that clear each pointer of a pipeline row while it still
 * names the key it was read naming — `keys` as `pipelineObjectKeys` read them,
 * in its order — and leave alone one another writer has moved on since.
 *
 * A column of its own goes to NULL, as does a `whole` jsonb column; a field
 * goes from its column, the rest of which stays.
 */
export function clearPipelineObjectKeys(keys: (string | null)[]): SQL {
  const read = PIPELINE_POINTERS.map((pointer, i) => ({ pointer, key: keys[i] ?? null }))
  const stillNames = ({ pointer, key }: (typeof read)[number]) =>
    sql`${sql.raw(pointerExpression(pointer))} IS NOT DISTINCT FROM ${key}::text`
  const columns = [...new Set(PIPELINE_POINTERS.map((pointer) => pointer.column))]
  return sql.join(
    columns.map((column) => {
      const own = read.filter(({ pointer }) => pointer.column === column)
      const fields = own.filter(({ pointer }) => pointer.field && !pointer.whole)
      let kept = sql.raw(column)
      if (fields.length > 0) {
        kept = sql`${kept} - array_remove(ARRAY[${sql.join(
          fields.map(
            (read) => sql`CASE WHEN ${stillNames(read)} THEN '${sql.raw(read.pointer.field!)}' END`
          ),
          sql`, `
        )}], NULL)`
      }
      for (const read of own.filter(({ pointer }) => !pointer.field || pointer.whole)) {
        kept = sql`CASE WHEN ${stillNames(read)} THEN NULL ELSE ${kept} END`
      }
      return sql`${sql.raw(column)} = ${kept}`
    }),
    sql`, `
  )
}

/**
 * A pipeline row's table column names as a jsonb array, `[]` for a row with
 * none: what the resource's search document carries (ADR-063), and so what a
 * writer of the metadata compares to know whether that document is stale.
 */
export function schemaColumnNames(metadata: SQL | AnyColumn): SQL<string[]> {
  return sql<
    string[]
  >`jsonb_path_query_array(COALESCE(${metadata}, '{}'::jsonb), '$.schema.columns[*].name')`
}

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
