/**
 * KUKAN Pipeline Type Definitions
 */

import type { Readable } from 'stream'

// ============================================================
// Pipeline Status Types
// ============================================================

export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'

export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'

export type PipelineStepName = 'fetch' | 'extract' | 'index'

export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const

/** Minimal resource data needed by pipeline steps */
export interface ResourceForPipeline {
  id: string
  packageId: string
  url: string | null
  urlType: string | null
  format: string | null
  hash: string | null
}

export interface PipelineContext {
  storage: {
    download(key: string): Promise<Readable>
    upload(key: string, body: Buffer | Readable, meta?: Record<string, unknown>): Promise<void>
  }
  /** Get an active resource by ID */
  getResource(id: string): Promise<ResourceForPipeline | null>
  /** Update resource hash, size, and lastModified (without touching updated) */
  updateResourceHashAndSize(id: string, meta: { hash: string; size: number }): Promise<void>
}

export interface ExtractedData {
  headers: string[]
  rows: string[][]
  encoding: string
}
