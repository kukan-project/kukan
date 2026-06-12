/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

import { z } from 'zod'

export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'
export type PipelineStepName = 'fetch' | 'extract' | 'index'

/** Content type for indexed resource text */
export type ContentType = 'tabular' | 'text' | 'manifest' | 'document'

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
