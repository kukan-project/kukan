/**
 * The one-time migration that gives previews written before it the row group
 * size a feed pages by (ADR-055 §6). Beside the feed because it reads footers
 * through the feed's session and decides by the feed's page budget.
 */

import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline } from '@kukan/db'
import { PARQUET_PREVIEW_ROW_GROUP_ROWS, createCache } from '@kukan/shared'
import type { Env, Logger } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { readRowGroupRows } from '@kukan/lake'
import { PipelineService, parseResourceSchema, parseSourceEncoding } from '../pipeline-service'
import { prepareFeedInstance } from './session'
import { estimateRowBytes, rowsMayBeTooWide } from './page-budget'
import {
  ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS,
  ODATA_MEMORY_LIMIT_BYTES,
  ODATA_READ_TIMEOUT_MS,
} from '../../config'

/** Recorded where a preview was asked for its row group size and had none. */
const NO_ROW_GROUP_FIGURE = 0

/** How DuckDB says an object is not there — over S3, and on a local path. */
const OBJECT_MISSING = /\b404\b|Not Found|NoSuchKey|No files found/i

interface RowGroupStatus {
  /** Previews that never recorded what their row groups hold. */
  unrecordedCount: number
  /** Of those, the ones a smaller group would let the feed serve. */
  reinterpretCount: number
}

const ROW_GROUP_STATUS_KEY = 'row-group-status'
const rowGroupStatus = createCache({ max: 1, ttlMs: 60 * 1000 })

/**
 * Which previews the row-group migration has work on.
 *
 * **Only previews a page could be made of.** A preview key is not always a
 * Parquet — a ZIP's is a JSON listing of what is inside it — and a table the
 * interpretation found no rows in has no groups to report. Asking the footer
 * about either fails, and counting them leaves a control on screen that
 * pressing can never clear. The row count settles both: absent for a
 * non-tabular preview, zero for an empty table.
 *
 * Deleted resources are out for the reason `PipelineService.enqueueAll` leaves
 * them out: they
 * are neither served nor worth a pipeline run.
 */
function rowGroupBackfillWhere() {
  return and(
    isNotNull(resourcePipeline.previewKey),
    sql`${resourcePipeline.metadata}->>'rowGroupRows' IS NULL`,
    sql`(${resourcePipeline.metadata}->'schema'->>'rowCount')::bigint > 0`,
    eq(resource.state, 'active'),
    inArray(packageTable.state, ['active', 'draft'])
  )
}

/**
 * Whether writing this preview's groups at the size the interpretation uses now
 * would move the table from "cannot be read" to "can" (ADR-055 §6).
 *
 * A page is read a row group at a time, so what it needs follows
 * `group rows × row bytes`. The band this asks about is narrow on purpose:
 * below it the table is served whatever its groups hold, above it a smaller
 * group does not save it either, and only inside does rewriting the preview
 * change what a reader gets.
 *
 * Measured against the caution line rather than where reads actually fail: this
 * decides whether to spend a re-interpretation, and erring either way costs
 * little — one needless rewrite, or a table left as it was.
 */
function regroupingWouldServe(groupRows: number, size: number | null, metadata: unknown): boolean {
  const schema = parseResourceSchema(metadata)
  if (!schema || schema.columns.length === 0) return false
  const rowBytes = estimateRowBytes(size, parseSourceEncoding(metadata), schema)
  return (
    rowsMayBeTooWide(rowBytes, groupRows) &&
    !rowsMayBeTooWide(rowBytes, PARQUET_PREVIEW_ROW_GROUP_ROWS)
  )
}

/**
 * Previews that never recorded what their row groups hold.
 *
 * Drives the one-time control an operator presses: the count is what is left,
 * and it only ever falls — the interpretation records the figure for every
 * preview it writes now.
 *
 * **Answered from a short-lived cache**, because the dashboard asks on every
 * render and the answer costs every candidate's metadata (the band,
 * `regroupingWouldServe`, needs each table's columns, and writing that comparison a second time in
 * SQL is the drift this is avoiding). A figure a minute old can only be too
 * high, and the control it draws is not one anyone presses twice.
 */
export async function countPreviewsWithoutRowGroups(db: Database): Promise<RowGroupStatus> {
  const cached: RowGroupStatus | undefined = rowGroupStatus.get(ROW_GROUP_STATUS_KEY)
  if (cached !== undefined) return cached
  const status = await readRowGroupStatus(db)
  rowGroupStatus.set(ROW_GROUP_STATUS_KEY, status)
  return status
}

async function readRowGroupStatus(db: Database): Promise<RowGroupStatus> {
  const rows = await rowGroupBackfillCandidates(db)
  // **The same predicate the job will apply, on the same rows** — a count in
  // SQL beside it would be the band written twice, and the two would drift.
  //
  // Approximate in one direction only: the job knows each file's real group
  // because it has read the footer by then, and this has to assume the
  // largest an unrecorded file can hold. A file that turns out to be smaller
  // is one the job finds it need not rewrite, so this can over-count and
  // never under-counts.
  const reinterpretCount = rows.filter((row) =>
    regroupingWouldServe(ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS, row.size, row.metadata)
  ).length
  return { unrecordedCount: rows.length, reinterpretCount }
}

/** The rows themselves, for the pass that reads their footers. */
async function rowGroupBackfillCandidates(db: Database) {
  return db
    .select({
      resourceId: resourcePipeline.resourceId,
      previewKey: resourcePipeline.previewKey,
      metadata: resourcePipeline.metadata,
      size: resource.size,
      hasStoredContent: isNotNull(resource.storageKey).mapWith(Boolean),
    })
    .from(resourcePipeline)
    .innerJoin(resource, eq(resource.id, resourcePipeline.resourceId))
    .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
    .where(rowGroupBackfillWhere())
}

/**
 * Read each unrecorded preview's footer and write the figure down.
 *
 * **Why it is worth an operator's button.** Without the number a feed cannot
 * cut its pages at row-group boundaries — two writers made previews at two
 * sizes and neither can be guessed — so such a table is served as if every
 * page straddled, at half the row width it could manage. A page can ask the
 * file itself, but it asks again in the next process; this settles it.
 *
 * One DuckDB session for the whole pass rather than one per file: the read is
 * a footer, and the session is the expensive part. Failures are counted and
 * skipped — a preview whose object is gone is the sweep's business, not this
 * one's — so a single bad row cannot stop the migration.
 *
 * **Not guarded against a second pass**, which a second press can start: it
 * rewrites the same figures and queues the few re-interpretations again, which
 * the execution claim (ADR-044) runs one after the other. A lock would hold a
 * connection for the whole pass to save that.
 */
export async function recordMissingRowGroups(
  db: Database,
  deps: {
    storage: StorageAdapter
    env: Env
    /** Given, the few tables a smaller group would let through are re-interpreted. */
    queue?: QueueAdapter
    log?: Logger
  }
): Promise<{ recorded: number; unmeasured: number; reinterpreting: number; failed: number }> {
  const rows = await rowGroupBackfillCandidates(db)
  if (rows.length === 0) return { recorded: 0, unmeasured: 0, reinterpreting: 0, failed: 0 }

  const session = await prepareFeedInstance({
    location: deps.storage.readUrl(rows[0].previewKey!),
    env: deps.env,
    memoryLimitBytes: ODATA_MEMORY_LIMIT_BYTES,
    readTimeoutMs: ODATA_READ_TIMEOUT_MS,
  })
  let recorded = 0
  let unmeasured = 0
  let failed = 0
  let reinterpreting = 0
  const pipeline = deps.queue ? new PipelineService(db, deps.queue) : null
  try {
    for (const row of rows) {
      const previewKey = row.previewKey!
      try {
        let groupRows: number | null
        try {
          groupRows = await readRowGroupRows(session.conn, deps.storage.readUrl(previewKey))
        } catch (err) {
          // **A missing object is an answer, not a failure.** Left a
          // candidate, it would be read again on every pass and keep the
          // prompt on screen for good — pressing the button could never
          // clear it. Anything else may be transient and stays a candidate.
          if (!OBJECT_MISSING.test(err instanceof Error ? err.message : String(err))) throw err
          groupRows = null
        }
        if (groupRows === null) {
          await recordRowGroupRows(db, previewKey, NO_ROW_GROUP_FIGURE)
          unmeasured++
          continue
        }
        // Enqueued before the row is recorded, and **not recorded at all if
        // the enqueue fails**: recording takes this preview out of the
        // candidate query, so either order that lets the figure land without
        // the job leaves a table nothing ever comes back for — the prompt
        // clears, and running the pass again does not find it.
        // Only where there is stored content to rebuild from: without it the
        // job is refused at its first step ("no content to rebuild from") and
        // leaves the resource's pipeline in error for nothing.
        if (
          pipeline &&
          row.hasStoredContent &&
          regroupingWouldServe(groupRows, row.size, row.metadata)
        ) {
          // A throw skips the record below and is counted as a failure.
          await pipeline.enqueue(row.resourceId, { rebuildOnly: true })
          reinterpreting++
        }
        await recordRowGroupRows(db, previewKey, groupRows)
        recorded++
      } catch (err) {
        failed++
        deps.log?.warn({ previewKey, err }, 'could not record row group size')
      }
    }
  } finally {
    await session.close()
  }

  return { recorded, unmeasured, reinterpreting, failed }
}

/**
 * Record what a preview's row groups hold, for a file that never said.
 *
 * Keyed on the preview key rather than the resource: it names the bytes this
 * figure is about, so a re-interpretation — which writes a new key — leaves
 * nothing for this to update, and the next reader asks the new file instead of
 * inheriting a number from the old one. Merged into the metadata because the
 * schema and source hash beside it belong to the interpretation.
 *
 * `updated` is deliberately left alone: this is a reader filling in a fact
 * about an existing preview, not a pipeline event, and the admin views order
 * by that column.
 *
 * Private because the migration is the only thing that should write it — a
 * feed page reads the figure and never records it (ADR-055 §6).
 */
async function recordRowGroupRows(db: Database, previewKey: string, rows: number): Promise<void> {
  await db.execute(sql`
    UPDATE resource_pipeline
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ rowGroupRows: rows })}::jsonb
    WHERE preview_key = ${previewKey}
  `)
}
