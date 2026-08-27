/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, and, exists, inArray, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { ValidationError, PIPELINE_JOB_TYPE, resourceSchemaSchema } from '@kukan/shared'
import type { PipelineStatus, ResourceSchema } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'

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
   */
  async enqueueAll(): Promise<{ enqueued: number; failed: number }> {
    const resources = await this.db
      .select({ id: resource.id })
      .from(resource)
      .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
      .where(and(eq(resource.state, 'active'), inArray(packageTable.state, ['active', 'draft'])))

    const BATCH_SIZE = 100
    let enqueued = 0
    let failed = 0
    for (let i = 0; i < resources.length; i += BATCH_SIZE) {
      const batch = resources.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(batch.map((r) => this.enqueue(r.id)))
      for (const r of results) {
        if (r.status === 'fulfilled') enqueued++
        else failed++
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
      })
      .from(resourcePipeline)
      .innerJoin(resource, eq(resource.id, resourcePipeline.resourceId))
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    if (!row) return null
    return {
      previewKey: row.previewKey,
      schema: parseResourceSchema(row.metadata),
      describesLiveContent: row.describesLiveContent,
    }
  }
}

export interface QueryTarget {
  previewKey: string | null
  schema: ResourceSchema | null
  /** Whether the preview/schema were built from the bytes the resource holds now. */
  describesLiveContent: boolean
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
