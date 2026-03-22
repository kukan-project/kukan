/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'

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
