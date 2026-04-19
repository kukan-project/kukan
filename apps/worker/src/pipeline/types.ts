/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'
import type { ContentDoc } from '@kukan/search-adapter'

/** Minimal resource data needed by pipeline steps */
export interface ResourceForPipeline {
  id: string
  packageId: string
  name: string | null
  description: string | null
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
  /**
   * Atomically acquire a fetch slot for the given FQDN.
   * Returns true if the slot was acquired (i.e. last fetch was >1s ago or first time).
   * Returns false if rate-limited (another fetch happened within the last second).
   */
  acquireFetchSlot(fqdn: string): Promise<boolean>
  /** Index extracted content into the search index.
   *  No-op when OpenSearch is not configured. */
  indexContent(doc: ContentDoc): Promise<void>
  /** Update pipeline metadata JSONB (merges with existing metadata) */
  updatePipelineMetadata(pipelineId: string, metadata: Record<string, unknown>): Promise<void>
}
