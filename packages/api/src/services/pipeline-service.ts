/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, and, exists, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import {
  ValidationError,
  PIPELINE_JOB_TYPE,
  PARQUET_PREVIEW_ROW_GROUP_ROWS,
  createCache,
  primaryKeyOf,
  resourceSchemaSchema,
} from '@kukan/shared'
import type { Env, Logger, PipelineStatus, ResourceSchema } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { readRowGroupRows } from '@kukan/lake'
import { openSession } from './odata/session'
import { estimateRowBytes, rowsMayBeTooWide } from './odata/page-budget'
import {
  ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS,
  ODATA_MEMORY_LIMIT_BYTES,
  ODATA_READ_TIMEOUT_MS,
} from '../config'

/**
 * Validate `resource_pipeline.metadata.schema` (persisted by the Interpret step,
 * ADR-032), returning null when absent or malformed so unverified data never
 * leaks to callers.
 */
export function parseResourceSchema(metadata: unknown): ResourceSchema | null {
  const schema = (metadata as { schema?: unknown } | null | undefined)?.schema
  const parsed = resourceSchemaSchema.safeParse(schema)
  return parsed.success ? parsed.data : null
}

/**
 * The encoding the interpretation read the file in, where it recorded one.
 *
 * Written beside the schema by the Interpret step; absent on rows from before
 * it was. What reads it is the feed's row-size estimate, which measures the
 * source file and serves it as UTF-8 (ADR-055).
 */
function parseSourceEncoding(metadata: unknown): string | null {
  const encoding = (metadata as { encoding?: unknown } | null | undefined)?.encoding
  return typeof encoding === 'string' ? encoding : null
}

/**
 * Rows in one row group of the preview Parquet, where the interpretation
 * recorded it.
 *
 * The unit a page is read in, not a property of the table: a Parquet read
 * decodes a whole group to hand out one row of it, so the feed keeps a page
 * inside one (ADR-055). Absent on previews written before it was recorded —
 * the feed then reads the footer, and failing that pages by bytes alone
 * (`pageRowsWithin`).
 *
 * `0` is recorded, and reads back as null, where the file was asked and had no
 * single figure to give: its groups disagree, or the object is gone. It takes
 * the preview out of the migration's candidates without claiming a size.
 */
function parseRowGroupRows(metadata: unknown): number | null {
  const rows = (metadata as { rowGroupRows?: unknown } | null | undefined)?.rowGroupRows
  return typeof rows === 'number' && Number.isInteger(rows) && rows > 0 ? rows : null
}

const ENQUEUE_BATCH_SIZE = 100

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
 * Deleted resources are out for the reason `enqueueAll` leaves them out: they
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

export class PipelineService {
  constructor(
    private db: Database,
    private queue?: QueueAdapter
  ) {}

  /**
   * Create or reset a pipeline for a resource and enqueue processing.
   * Returns the queue job ID.
   */
  async enqueue(resourceId: string, opts: { rebuildOnly?: boolean } = {}): Promise<string> {
    if (!this.queue) {
      throw new ValidationError('Queue adapter is required to enqueue pipelines')
    }

    // Upsert pipeline record — preserve existing previewKey/metadata until Worker starts
    const [pipeline] = await this.db
      .insert(resourcePipeline)
      .values({
        resourceId,
        status: 'queued' satisfies PipelineStatus,
        error: null,
        previewKey: null,
        metadata: null,
      })
      .onConflictDoUpdate({
        target: resourcePipeline.resourceId,
        set: {
          status: 'queued' satisfies PipelineStatus,
          error: null,
          updated: sql`NOW()`,
        },
      })
      .returning()

    // Enqueue processing job — rollback DB status on failure
    try {
      const jobId = await this.queue.enqueue(PIPELINE_JOB_TYPE, { resourceId, ...opts })
      return jobId
    } catch (err) {
      await this.db
        .update(resourcePipeline)
        .set({
          status: 'error' satisfies PipelineStatus,
          error: `Queue enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
          updated: sql`NOW()`,
        })
        .where(eq(resourcePipeline.id, pipeline.id))
      throw err
    }
  }

  /**
   * Enqueue pipeline processing for all active resources.
   * Individual enqueue failures are counted but do not stop the batch.
   * Draft packages are included: their document resources carry the text-head
   * artifact a bulk reprocess must regenerate (ADR-040 addendum); the Index
   * step still keeps draft content out of the search index (ADR-039).
   *
   * @param opts.rebuildOnly - work from the object each resource already holds
   *   rather than fetching its URL again (ADR-044 §4). Applied only where
   *   there is one: a resource with no stored object has nothing to rebuild
   *   from and would fail in Fetch, so it is fetched as before.
   */
  async enqueueAll(
    opts: { rebuildOnly?: boolean } = {}
  ): Promise<{ enqueued: number; failed: number }> {
    const resources = await this.db
      .select({
        id: resource.id,
        hasStoredContent: isNotNull(resource.storageKey).mapWith(Boolean),
      })
      .from(resource)
      .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
      .where(and(eq(resource.state, 'active'), inArray(packageTable.state, ['active', 'draft'])))

    const { enqueued, failed } = await this.enqueueMany(
      resources.map((r) => ({ id: r.id, rebuildOnly: opts.rebuildOnly && r.hasStoredContent }))
    )
    return { enqueued, failed: failed.length }
  }

  /**
   * Enqueue many runs, a hundred at a time, and settle each on its own: one
   * refusal costs its row, not the rest. A sequential loop would block the
   * single-threaded process for minutes on a catalog-sized list.
   */
  async enqueueMany(
    items: { id: string; rebuildOnly?: boolean }[]
  ): Promise<{ enqueued: number; failed: { id: string; reason: unknown }[] }> {
    let enqueued = 0
    const failed: { id: string; reason: unknown }[] = []
    for (let i = 0; i < items.length; i += ENQUEUE_BATCH_SIZE) {
      const batch = items.slice(i, i + ENQUEUE_BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map((item) => this.enqueue(item.id, { rebuildOnly: item.rebuildOnly }))
      )
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') enqueued++
        else failed.push({ id: batch[j].id, reason: r.reason })
      })
    }
    return { enqueued, failed }
  }

  /**
   * Get pipeline status with steps for a resource.
   */
  async getStatus(resourceId: string) {
    const [pipeline] = await this.db
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    if (!pipeline) {
      return null
    }

    const steps = await this.db
      .select()
      .from(resourcePipelineStep)
      .where(eq(resourcePipelineStep.pipelineId, pipeline.id))
      .orderBy(resourcePipelineStep.startedAt)

    return { ...pipeline, steps }
  }

  /**
   * Previews that never recorded what their row groups hold.
   *
   * Drives the one-time control an operator presses: the count is what is left,
   * and it only ever falls — the interpretation records the figure for every
   * preview it writes now.
   *
   * **Answered from a short-lived cache**, because the dashboard asks on every
   * render and the answer costs every candidate's metadata (the band below
   * needs each table's columns, and writing that comparison a second time in
   * SQL is the drift this is avoiding). A figure a minute old can only be too
   * high, and the control it draws is not one anyone presses twice.
   */
  async countPreviewsWithoutRowGroups(): Promise<RowGroupStatus> {
    const cached: RowGroupStatus | undefined = rowGroupStatus.get(ROW_GROUP_STATUS_KEY)
    if (cached !== undefined) return cached
    const status = await this.readRowGroupStatus()
    rowGroupStatus.set(ROW_GROUP_STATUS_KEY, status)
    return status
  }

  private async readRowGroupStatus(): Promise<RowGroupStatus> {
    const rows = await this.rowGroupBackfillCandidates()
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
  private async rowGroupBackfillCandidates() {
    return this.db
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
   */
  async recordMissingRowGroups(deps: {
    storage: StorageAdapter
    env: Env
    /** Given, the few tables a smaller group would let through are re-interpreted. */
    queue?: QueueAdapter
    log?: Logger
  }): Promise<{ recorded: number; unmeasured: number; reinterpreting: number; failed: number }> {
    const rows = await this.rowGroupBackfillCandidates()
    if (rows.length === 0) return { recorded: 0, unmeasured: 0, reinterpreting: 0, failed: 0 }

    const session = await openSession({
      location: deps.storage.readUrl(rows[0].previewKey!),
      env: deps.env,
      memoryLimitBytes: ODATA_MEMORY_LIMIT_BYTES,
      readTimeoutMs: ODATA_READ_TIMEOUT_MS,
    })
    let recorded = 0
    let unmeasured = 0
    let failed = 0
    let reinterpreting = 0
    const queue = deps.queue ? new PipelineService(this.db, deps.queue) : null
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
            await this.recordRowGroupRows(previewKey, NO_ROW_GROUP_FIGURE)
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
            queue &&
            row.hasStoredContent &&
            regroupingWouldServe(groupRows, row.size, row.metadata)
          ) {
            const { failed: queueFailed } = await queue.enqueueMany([
              { id: row.resourceId, rebuildOnly: true },
            ])
            if (queueFailed.length > 0) {
              failed += queueFailed.length
              continue
            }
            reinterpreting++
          }
          await this.recordRowGroupRows(previewKey, groupRows)
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
  private async recordRowGroupRows(previewKey: string, rows: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE resource_pipeline
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ rowGroupRows: rows })}::jsonb
      WHERE preview_key = ${previewKey}
    `)
  }

  /**
   * Resolve the inputs needed to run a server-side query (ADR-032 Part B) in a
   * single read: the preview Parquet storage key, the validated column schema,
   * and whether they describe the resource's current bytes. Returns null when
   * the resource has no pipeline row; each field is null when absent. Whether
   * the whole is queryable is `isQueryable`'s call.
   */
  async getQueryTarget(resourceId: string): Promise<QueryTarget | null> {
    const [row] = await this.db
      .select({
        previewKey: resourcePipeline.previewKey,
        metadata: resourcePipeline.metadata,
        describesLiveContent: schemaDescribesLiveContent(this.db),
        columnSettings: resource.columnSettings,
      })
      .from(resourcePipeline)
      .innerJoin(resource, eq(resource.id, resourcePipeline.resourceId))
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    if (!row) return null
    return {
      previewKey: row.previewKey,
      schema: parseResourceSchema(row.metadata),
      encoding: parseSourceEncoding(row.metadata),
      rowGroupRows: parseRowGroupRows(row.metadata),
      describesLiveContent: row.describesLiveContent,
      primaryKey: primaryKeyOf(row.columnSettings),
    }
  }
}

export interface QueryTarget {
  previewKey: string | null
  schema: ResourceSchema | null
  /** The encoding the source file was read in, where the interpretation said. */
  encoding: string | null
  /** Rows in one row group of the preview, where the interpretation recorded it. */
  rowGroupRows: number | null
  /** Whether the preview/schema were built from the bytes the resource holds now. */
  describesLiveContent: boolean
  /** Columns the publisher designated as the primary key (ADR-043 ii-b), if any. */
  primaryKey: string[] | null
}

/**
 * Whether `metadata.schema` (and the preview beside it) was built from the
 * bytes the resource holds now.
 *
 * **A failed interpretation keeps the previous preview and schema without
 * failing the run**, so after a content replacement the stored pair can
 * describe the old bytes. `sourceHash` is the proof; the fallback trusts a
 * completed run for previews from before the source hash existed — all of
 * which predate the rename (ADR-046), hence `'extract'`, not `'interpret'`.
 */
export function schemaDescribesLiveContent(db: Database) {
  // COALESCE: a null resource hash makes the comparison NULL, not false
  return sql<boolean>`COALESCE(
    ${resourcePipeline.metadata}->>'sourceHash' = ${resource.hash}
    OR (
      ${resourcePipeline.metadata}->>'sourceHash' IS NULL
      AND ${resourcePipeline.status} = 'complete'
      AND ${exists(
        db
          .select({})
          .from(resourcePipelineStep)
          .where(
            and(
              eq(resourcePipelineStep.pipelineId, resourcePipeline.id),
              eq(resourcePipelineStep.stepName, 'extract'),
              eq(resourcePipelineStep.status, 'complete')
            )
          )
      )}
    ),
    false
  )`
}

/**
 * Single source of truth for "can this resource be queried" (ADR-032): a
 * preview Parquet plus a schema with at least one column, both describing the
 * resource's current content. A persisted schema alone is not enough — an
 * interpretation that produced no table stores an empty schema with no
 * Parquet, purging a version can drop the preview while the schema stays
 * behind, and a replacement whose interpretation failed keeps the previous
 * (now stale) pair.
 */
export function isQueryable(
  target: QueryTarget | null
): target is QueryTarget & { previewKey: string; schema: ResourceSchema } {
  return (
    target?.previewKey != null &&
    target.schema != null &&
    target.schema.columns.length > 0 &&
    target.describesLiveContent
  )
}
