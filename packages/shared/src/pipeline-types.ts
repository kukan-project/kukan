/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

import { z } from 'zod'

/**
 * `cancelled` is a run that was stopped on purpose — a replacement was started,
 * or an operator killed it (ADR-044 §4). Distinct from `error`, which means the
 * run tried and failed: nothing went wrong here, and the resource is left
 * holding content no derivative describes.
 */
export type PipelineStatus =
  'pending' | 'queued' | 'processing' | 'complete' | 'error' | 'cancelled'
export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'
export type PipelineStepName = 'fetch' | 'version' | 'interpret' | 'lake' | 'index'

/**
 * Step names that runs no longer write but rows still carry.
 *
 * `extract` became `interpret` when the stage did (ADR-046). Steps are cleared
 * at the start of each run, so these disappear resource by resource as the
 * pipeline runs again — until then the history has to be able to label them.
 *
 * Removable when `SELECT count(*) FROM resource_pipeline_step WHERE step_name =
 * 'extract'` reaches zero, along with the `pipelineStepExtract` message keys.
 */
export type LegacyPipelineStepName = 'extract'

/** Content type for indexed resource text */
export type ContentType = 'tabular' | 'text' | 'manifest' | 'document'

// ── Resource (column) schema (ADR-032) ──
// The column schema inferred while generating the preview Parquet (ADR-029) is
// persisted to resource_pipeline.metadata.schema so it can be surfaced before
// the data is downloaded (e.g. the get_resource_schema MCP tool). Column types
// mirror the inferred types from the Interpret step.

/**
 * Inferred column type. `date` and `timestamp` arrived with DuckDB's sniffer
 * (ADR-046): the hand-written inference deliberately left dates as strings
 * because the format was ambiguous, which is a judgement the sniffer makes for
 * us. Appending to the set keeps schemas written before then valid.
 */
export const RESOURCE_COLUMN_TYPES = [
  'integer',
  'float',
  'boolean',
  'string',
  'date',
  'timestamp',
] as const
export type ResourceColumnType = (typeof RESOURCE_COLUMN_TYPES)[number]

/**
 * Min/max bounds for a numeric column. Present iff the column `type` is
 * `integer` or `float` (such columns always have at least one non-null value),
 * and absent for `boolean`/`string` — so presence is fully determined by
 * `type`. Integer bounds are decimal strings (INT64 can exceed JS Number's safe
 * range, so a string preserves exact digits); float bounds are numbers. `min`
 * and `max` are therefore always the same type within a column — the paired
 * union below rejects a mixed `{ min: string, max: number }`.
 */
export const columnStatsSchema = z.union([
  z.object({ min: z.string(), max: z.string() }),
  z.object({ min: z.number(), max: z.number() }),
])
export type ColumnStats = z.infer<typeof columnStatsSchema>

export const resourceColumnSchema = z.object({
  /** Column name (header, or `column_{index}` when the header is blank). */
  name: z.string(),
  /** Inferred semantic type. */
  type: z.enum(RESOURCE_COLUMN_TYPES),
  /** Whether the column has any missing (empty) values. */
  nullable: z.boolean(),
  /** Number of missing (empty) values in the column. */
  nullCount: z.number().int().nonnegative(),
  /**
   * Distinct non-null values, counted exactly over every row. Optional because
   * schemas written before ADR-046 have no such count — absent means unknown,
   * not zero.
   */
  distinctCount: z.number().int().nonnegative().optional(),
  /**
   * Whether the column identifies a row: every value distinct and none missing.
   * What the primary-key picker offers as candidates (ADR-046).
   */
  unique: z.boolean().optional(),
  /** Min/max bounds for numeric columns (omitted for boolean/string/all-null). */
  stats: columnStatsSchema.optional(),
})
export type ResourceColumn = z.infer<typeof resourceColumnSchema>

export const resourceSchemaSchema = z.object({
  columns: z.array(resourceColumnSchema),
  /** Number of data rows (excluding the header). */
  rowCount: z.number().int().nonnegative(),
})
export type ResourceSchema = z.infer<typeof resourceSchemaSchema>

// ── Queue job types ──
// Each job carries a validated payload (schemas below) so the worker never trusts
// an unvalidated queue message body.

/** Pipeline (data-plane): process one resource through Fetch → Version → Interpret → Lake → Index. */
export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const

/** Maintenance: rebuild the search metadata index (optionally re-enqueue content). */
export const REINDEX_JOB_TYPE = 'reindex-metadata' as const

/** Maintenance: permanently erase a soft-deleted organization (externals then DB rows). */
export const PURGE_ORG_JOB_TYPE = 'purge-organization' as const

/** Semantic search: (re)generate the embedding vector for one package (ADR-034). */
export const EMBED_JOB_TYPE = 'embed-package' as const

/** Legal deletion: permanently erase one resource version's content (ADR-043). */
export const PURGE_VERSION_JOB_TYPE = 'purge-resource-version' as const

/** One-time migration: snapshot the current file of every unversioned resource
 *  as v1 (ADR-043). No re-fetch/re-index — just copies the live key. */
export const BACKFILL_VERSIONS_JOB_TYPE = 'backfill-resource-versions' as const

/** Retry a DuckLake ingest the pipeline's advisory Lake step failed (ADR-043). */
export const LAKE_INGEST_JOB_TYPE = 'lake-ingest-version' as const

// ── Job payload schemas (the worker validates against these before acting) ──

export const pipelineJobSchema = z.object({ resourceId: z.uuid() })
export const reindexJobSchema = z.object({ includeContent: z.boolean().optional() })
export const purgeOrgJobSchema = z.object({ organizationId: z.uuid() })
export const embedJobSchema = z.object({ packageId: z.uuid() })
export const purgeVersionJobSchema = z.object({
  resourceId: z.uuid(),
  version: z.number().int().positive(),
})
export const backfillVersionsJobSchema = z.object({})
// Ids only, like every other job. What to read is settled by the version row —
// the handler interprets its file again (ADR-046) — so a message carrying
// anything else could only come to disagree with it. Messages queued before
// that carried a `previewKey`; unknown keys are stripped, so they still parse.
export const lakeIngestJobSchema = z.object({
  resourceId: z.uuid(),
  version: z.number().int().positive(),
})

/** A single file/directory entry in a ZIP manifest */
export interface ZipEntry {
  path: string
  size: number
  compressedSize: number
  lastModified: string
  isDirectory: boolean
}

/** Manifest describing the contents of a ZIP archive */
export interface ZipManifest {
  totalFiles: number
  totalSize: number
  totalCompressed: number
  truncated: boolean
  entries: ZipEntry[]
}
