/**
 * KUKAN Pipeline Service (API-side)
 * Handles enqueue and status queries — Worker-side execution is separate.
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline, resourcePipelineStep } from '@kukan/db'
import { ValidationError, PIPELINE_JOB_TYPE, resourceSchemaSchema } from '@kukan/shared'
import type { PipelineStatus, ResourceSchema } from '@kukan/shared'
import type { QueueAdapter } from '@kukan/queue-adapter'

export class PipelineService {
  constructor(
    private db: Database,
    private queue?: QueueAdapter
  ) {}

  /**
   * Create or reset a pipeline for a resource and enqueue processing.
   * Returns the queue job ID.
   */
  async enqueue(resourceId: string): Promise<string> {
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
      const jobId = await this.queue.enqueue(PIPELINE_JOB_TYPE, { resourceId })
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
   * Resources under draft packages are skipped — their content is never
   * indexed and publish re-enqueues them (ADR-039).
   */
  async enqueueAll(): Promise<{ enqueued: number; failed: number }> {
    const resources = await this.db
      .select({ id: resource.id })
      .from(resource)
      .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
      .where(and(eq(resource.state, 'active'), eq(packageTable.state, 'active')))

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
   * Get the persisted column schema for a resource (ADR-032), or null when the
   * resource has no tabular schema (non-tabular format, oversize CSV, or not yet
   * processed). The schema is stored in resource_pipeline.metadata.schema by the
   * Extract step; it is validated here so a malformed value yields null rather
   * than leaking unverified data.
   */
  /** Validate `metadata.schema`, returning null when absent or malformed. */
  private parseSchema(metadata: unknown): ResourceSchema | null {
    const schema = (metadata as { schema?: unknown } | null | undefined)?.schema
    const parsed = resourceSchemaSchema.safeParse(schema)
    return parsed.success ? parsed.data : null
  }

  async getSchema(resourceId: string): Promise<ResourceSchema | null> {
    const [row] = await this.db
      .select({ metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    return this.parseSchema(row?.metadata)
  }

  /**
   * Resolve the inputs needed to run a server-side query (ADR-032 Part B) in a
   * single read: the preview Parquet storage key and the validated column schema.
   * Returns null when the resource has no pipeline row; `previewKey`/`schema` are
   * individually null when the resource is not queryable (non-tabular, oversize,
   * or not yet processed).
   */
  async getQueryTarget(
    resourceId: string
  ): Promise<{ previewKey: string | null; schema: ResourceSchema | null } | null> {
    const [row] = await this.db
      .select({ previewKey: resourcePipeline.previewKey, metadata: resourcePipeline.metadata })
      .from(resourcePipeline)
      .where(eq(resourcePipeline.resourceId, resourceId))
      .limit(1)

    if (!row) return null
    return { previewKey: row.previewKey, schema: this.parseSchema(row.metadata) }
  }
}
