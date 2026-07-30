/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'
import type { ContentDoc } from '@kukan/search-adapter'
import type { ObjectMeta } from '@kukan/storage-adapter'
import type { IngestResult } from '@kukan/lake'
import type { PackageDbState, ResourceSchema } from '@kukan/shared'
import type { PublishedContent } from '@kukan/api/services/storage-pointer'
import type { ResourceClaim } from '@kukan/api/services/pipeline-claim'

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
  /** Key of the object holding the content, null when nothing is stored yet. */
  storageKey: string | null
}

export interface PipelineContext {
  /**
   * Reading only. Creating an object goes through {@link putObject}, and not
   * offering the raw write here is what keeps that from being bypassed — a step
   * cannot record nothing if it has nothing to write with (ADR-045).
   */
  storage: {
    download(key: string): Promise<Readable>
  }
  /** Get an active resource by ID */
  getResource(id: string): Promise<ResourceForPipeline | null>
  /** Get a package's state (null when the package doesn't exist) */
  getPackageState(packageId: string): Promise<PackageDbState | null>
  /**
   * Publish the object this run wrote as the resource's content (ADR-043).
   *
   * @returns whether this run's object became the live content.
   */
  publishContent(id: string, content: PublishedContent): Promise<boolean>
  /**
   * Write an object, recording the key first (ADR-045).
   *
   * The record is what makes the object reachable if this run dies before a
   * pointer references it; the statement that commits the pointer removes it.
   * Every object this pipeline creates goes through here, so forgetting is not
   * a thing a step can do.
   */
  putObject(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
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
    /**
     * The key this run wrote, holding the content to capture. Nothing rewrites
     * it, so the copy is the content Fetch measured and Extract parsed — the
     * version, its hash and its schema cannot come apart.
     */
    currentStorageKey: string
    /** Hash Fetch measured on that object; gates the capture and is recorded. */
    contentHash: string
    /** Size Fetch measured on that object. */
    contentSize: number
    /** Column schema from Extract (CSV/TSV only), snapshotted onto the version. */
    schema: ResourceSchema | null
    /**
     * This run's claim. The version row is the one thing a capture leaves
     * behind for the resource rather than for the run, so it is written under
     * the claim like every other durable write (ADR-044 §4).
     */
    claim: ResourceClaim
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
