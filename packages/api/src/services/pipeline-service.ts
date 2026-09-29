/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, and, exists, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { packageTable, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import {
  NotFoundError,
  ValidationError,
  PIPELINE_JOB_TYPE,
  primaryKeyOf,
  resourceSchemaSchema,
} from '@kukan/shared'
import type { PipelineStatus, ResourceSchema } from '@kukan/shared'
import type { EnqueueOptions, QueueAdapter } from '@kukan/queue-adapter'

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
export function parseSourceEncoding(metadata: unknown): string | null {
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

/** Runs per transaction in a bulk enqueue: few statements, row locks held briefly. */
const ENQUEUE_BATCH_SIZE = 500

export class PipelineService {
  constructor(
    private db: Database,
    private queue?: QueueAdapter
  ) {}

  private requireQueue(): QueueAdapter {
    if (!this.queue) {
      throw new ValidationError('Queue adapter is required to enqueue pipelines')
    }
    return this.queue
  }

  /**
   * Put these resources' pipeline rows back to `queued`, keeping the
   * previewKey/metadata a finished run left until the worker starts. Returns
   * the ids it marked.
   *
   * Chosen from `resource`, in id order, for the reasons `ensureClaimable`
   * (pipeline-claim.ts) gives for the same statement: a resource deleted since
   * the caller listed it drops out instead of refusing the batch on its
   * foreign key, and writers that share rows take their locks in one order.
   */
  private async markQueued(tx: Transaction, resourceIds: string[]): Promise<Set<string>> {
    const result = await tx.execute(sql`
      INSERT INTO resource_pipeline (resource_id, status)
      SELECT id, ${'queued' satisfies PipelineStatus} FROM resource
      WHERE id = ANY(${sql.param(resourceIds)}::uuid[])
      ORDER BY id
      ON CONFLICT (resource_id) DO UPDATE SET status = excluded.status, error = NULL, updated = NOW()
      RETURNING resource_id AS "resourceId"
    `)
    return new Set((result.rows as { resourceId: string }[]).map((r) => r.resourceId))
  }

  /**
   * Create or reset a pipeline for a resource and enqueue processing.
   * Returns the queue job ID.
   *
   * The row and the job commit together (ADR-058): a row left `queued` with
   * no job behind it is one nothing will ever process. Given `tx`, both are
   * written in it, and whoever opened it with `queue.transaction` wakes the
   * worker after the commit.
   */
  async enqueue(
    resourceId: string,
    opts: { rebuildOnly?: boolean } & Pick<EnqueueOptions, 'tx' | 'priority'> = {}
  ): Promise<string> {
    const queue = this.requireQueue()
    const { tx: callerTx, priority, ...job } = opts
    const write = async (tx: Transaction) => {
      if (!(await this.markQueued(tx, [resourceId])).has(resourceId)) {
        throw new NotFoundError('Resource', resourceId)
      }
      return queue.enqueue(PIPELINE_JOB_TYPE, { resourceId, ...job }, { tx, priority })
    }
    return callerTx ? write(callerTx) : queue.transaction(this.db, write)
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
      resources.map((r) => ({ id: r.id, rebuildOnly: opts.rebuildOnly && r.hasStoredContent })),
      // The whole catalog, whoever asks: nobody waits for any one run (ADR-058 §6)
      { priority: 'low' }
    )
    return { enqueued, failed: failed.length }
  }

  /**
   * Enqueue many runs, a batch per transaction: one refusal costs its batch,
   * not the rest, and each batch is two statements however large it is. A
   * resource deleted since it was listed is skipped, counted in neither.
   */
  async enqueueMany(
    items: { id: string; rebuildOnly?: boolean }[],
    opts: Pick<EnqueueOptions, 'priority'> = {}
  ): Promise<{ enqueued: number; failed: { id: string; reason: unknown }[] }> {
    const queue = this.requireQueue()
    // One run per resource: the upsert cannot touch the same row twice
    const unique = [...new Map(items.map((item) => [item.id, item])).values()]
    let enqueued = 0
    const failed: { id: string; reason: unknown }[] = []
    for (let i = 0; i < unique.length; i += ENQUEUE_BATCH_SIZE) {
      const batch = unique.slice(i, i + ENQUEUE_BATCH_SIZE)
      try {
        // A resource deleted since it was listed is neither: it has nothing to run
        enqueued += await queue.transaction(this.db, async (tx) => {
          const marked = await this.markQueued(
            tx,
            batch.map((item) => item.id)
          )
          const runs = batch.filter((item) => marked.has(item.id))
          await queue.enqueueMany(
            PIPELINE_JOB_TYPE,
            runs.map((item) => ({ resourceId: item.id, rebuildOnly: item.rebuildOnly })),
            { tx, priority: opts.priority }
          )
          return runs.length
        })
      } catch (reason) {
        failed.push(...batch.map((item) => ({ id: item.id, reason })))
      }
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
