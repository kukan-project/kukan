/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

import { z } from 'zod'

export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'
export type PipelineStepName = 'fetch' | 'extract' | 'index'

/** Content type for indexed resource text */
export type ContentType = 'tabular' | 'text' | 'manifest' | 'document'

// ── Resource (column) schema (ADR-032) ──
// The column schema inferred while generating the preview Parquet (ADR-029) is
// persisted to resource_pipeline.metadata.schema so it can be surfaced before
// the data is downloaded (e.g. the get_resource_schema MCP tool). Column types
// mirror the inferred types from the Extract step.

/** Inferred column type (same set as the Extract step's type inference, ADR-029). */
export const RESOURCE_COLUMN_TYPES = ['integer', 'float', 'boolean', 'string'] as const
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

/** Pipeline (data-plane): process one resource through Fetch → Extract → Index. */
export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const

/** Maintenance: rebuild the search metadata index (optionally re-enqueue content). */
export const REINDEX_JOB_TYPE = 'reindex-metadata' as const

/** Maintenance: permanently erase a soft-deleted organization (externals then DB rows). */
export const PURGE_ORG_JOB_TYPE = 'purge-organization' as const

// ── Job payload schemas (the worker validates against these before acting) ──

export const pipelineJobSchema = z.object({ resourceId: z.uuid() })
export const reindexJobSchema = z.object({ includeContent: z.boolean().optional() })
export const purgeOrgJobSchema = z.object({ organizationId: z.uuid() })

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
