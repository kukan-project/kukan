/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'

export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'

export type PipelineStepName = 'fetch' | 'extract' | 'index'

/** Content type for indexed resource text */
export type ContentType = 'tabular' | 'text' | 'manifest' | 'document'

export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const

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
