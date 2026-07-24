/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'
import type { ContentDoc } from '@kukan/search-adapter'
import type { PackageDbState, ResourceSchema } from '@kukan/shared'

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
  size: number | null
}

/** A newly captured version row (ADR-043, layer 1). */
export interface NewResourceVersion {
  resourceId: string
  version: number
  storageKey: string
  size: number | null
  hash: string | null
  origin: 'upload' | 'fetch'
  schema: ResourceSchema | null
}

export interface PipelineContext {
  storage: {
    download(key: string): Promise<Readable>
    upload(key: string, body: Buffer | Readable, meta?: Record<string, unknown>): Promise<void>
    /** Server-side copy for immutable version capture (ADR-043). */
    copy(sourceKey: string, destKey: string): Promise<void>
  }
  /** Get an active resource by ID */
  getResource(id: string): Promise<ResourceForPipeline | null>
  /** Get a package's state (null when the package doesn't exist) */
  getPackageState(packageId: string): Promise<PackageDbState | null>
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
  /** Delete all content chunks for a resource.
   *  No-op when OpenSearch is not configured. */
  deleteContent(resourceId: string): Promise<void>
  /** Update pipeline metadata JSONB (merges with existing metadata) */
  updatePipelineMetadata(pipelineId: string, metadata: Record<string, unknown>): Promise<void>
  /**
   * Info needed to decide version capture:
   * - maxVersion: highest version number across ALL rows (incl. purged tombstones),
   *   so the next number never collides on the unique (resource_id, version) index.
   * - latestActiveHash: content hash of the highest-numbered *active* version, used
   *   as the change gate. Distinct from maxVersion because a purged tombstone can
   *   sit above the live version (e.g. after a latest-version purge + rollback).
   */
  getVersionCaptureInfo(
    resourceId: string
  ): Promise<{ maxVersion: number | null; latestActiveHash: string | null }>
  /** Insert a captured version row. */
  insertResourceVersion(row: NewResourceVersion): Promise<void>
}
