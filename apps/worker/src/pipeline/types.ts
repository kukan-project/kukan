/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'
import type { ContentDoc } from '@kukan/search-adapter'
import type { IngestResult } from '@kukan/lake'
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
  /**
   * Mark the resource's live object as being replaced (ADR-043).
   *
   * Clears the recorded hash so a version capture or backfill running
   * concurrently reads "hash is null" as "these bytes are moving" and steps
   * aside instead of attributing them to a version. Every writer of the live
   * key does this first — Fetch, the upload flow, and the purge rollback.
   */
  beginContentReplacement(id: string): Promise<void>
  /**
   * Record what the live object now holds.
   *
   * `lastModified` moves only when the content actually changed, so an unchanged
   * re-fetch is not an edit. The comparison uses `previousHash` rather than the
   * stored value, which {@link beginContentReplacement} has already cleared.
   */
  recordContent(
    id: string,
    content: { hash: string; size: number; previousHash: string | null }
  ): Promise<void>
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
   * Capture the resource's current file as its next version (ADR-043 layer 1).
   *
   * The whole sequence — change gate, next number, copy, insert — runs under a
   * per-resource advisory lock on a single transaction. Serialized, because two
   * runs would otherwise pick the same N and the second copy would overwrite
   * the first's file while only one insert survived the unique index. On one
   * transaction, because a lock held while reaching back to the pool for the
   * reads and the insert exhausts it.
   */
  captureVersion(input: {
    resourceId: string
    packageId: string
    /** The resource's live key, holding the content to capture. */
    currentStorageKey: string
    /** Column schema from Extract (CSV/TSV only), snapshotted onto the version. */
    schema: ResourceSchema | null
    /**
     * Hash of the bytes Extract parsed, when it produced a schema. Extract and
     * the copy both read the shared live key, so a concurrent run can leave the
     * schema describing different content than the version holds — capture is
     * abandoned rather than recording the mismatch.
     */
    sourceHash: string | undefined
  }): Promise<{ captured: false } | { captured: true; version: number }>
  /**
   * The active version holding exactly these bytes and not yet in DuckLake, or
   * null (ADR-043 layer 2).
   *
   * Asked every run, not only when a version was just captured: a Lake step that
   * failed once would otherwise never retry — the next run finds the content
   * unchanged, skips the capture, and once a newer version exists the backfill
   * cannot reach the older one either, leaving that pair permanently undiffable.
   */
  pendingLakeVersion(resourceId: string, contentHash: string): Promise<number | null>
  /**
   * Layer 2 (ADR-043 Phase ii): load a captured version's tabular content into
   * DuckLake from its preview Parquet and record the snapshot on the version
   * row. Returns null when the context was built without a DuckLake config.
   */
  ingestLakeVersion(opts: {
    resourceId: string
    version: number
    previewKey: string
  }): Promise<IngestResult | null>
}
