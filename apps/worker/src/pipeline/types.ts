/**
 * Worker-only pipeline type definitions.
 * Shared types (PipelineStatus, PipelineStepName, etc.) come from @kukan/shared.
 */

import type { Readable } from 'node:stream'
import type { ContentDoc } from '@kukan/search-adapter'
import type { ObjectMeta } from '@kukan/storage-adapter'
import type { IngestResult } from '@kukan/lake'
import type { NoTableReason, PackageDbState, ResourceSchema } from '@kukan/shared'
import type { PublishedContent } from '@kukan/api/services/storage-pointer'
import type { LakeIngestRow } from '@kukan/api/services/lake-ingest'
import type { ResourceClaim } from '@kukan/api/services/pipeline-claim'
import type { VersionResult } from './version-gate'

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
   * Create the resource's current file as its next version (ADR-043 layer 1).
   *
   * The whole sequence — change gate, next number, own or copy, insert — is
   * protected by the run's claim on the resource, not a lock of its own
   * (ADR-044 §5).
   * Nothing else is choosing a version number while the claim is held, so the
   * reads need no transaction. What the claim does not catch is a run taken over
   * for being stale and still alive, which the pointer comparison in the gate is
   * there for.
   */
  createVersion(input: {
    resourceId: string
    /** Only for the key a copy needs; the ordinary path mints none. */
    packageId: string
    /**
     * The key this run wrote, holding the content to create — and the key the
     * version names when nothing else owns it (ADR-043 §1). Nothing rewrites
     * it, so the bytes the version promises are the ones Fetch measured; the
     * two cannot come apart, and no copy has to be made to keep them together.
     */
    currentStorageKey: string
    /** Hash Fetch measured on that object; gates version creation, and is recorded. */
    contentHash: string
    /** Size Fetch measured on that object. */
    contentSize: number
    /**
     * This run's claim. The version row is the one thing creating a version leaves
     * behind for the resource rather than for the run, so it is written under
     * the claim like every other durable write (ADR-044 §4).
     */
    claim: ResourceClaim
  }): Promise<VersionResult>
  /**
   * The active version holding exactly these bytes, or null (ADR-046).
   *
   * What Interpret reads. Asked rather than taken from the creation, because a
   * run that created nothing still has a version to interpret: the content was
   * already there under an earlier number, and its earlier interpretation may
   * have failed. The same lookup answers both, and the file it names never
   * changes — which is what makes interpretation re-runnable.
   *
   * Null means no version holds this run's content: the creation failed, or
   * another run moved the pointer and this one is no longer describing the
   * resource. Either way there is nothing to interpret yet, and the run that
   * does create these bytes will interpret them.
   *
   * The format comes back with it, and it is the one Interpret reads by
   * (ADR-046 §6).
   */
  versionForContent(
    resourceId: string,
    contentHash: string
  ): Promise<{
    version: number
    storageKey: string
    size: number
    format: string | null
  } | null>
  /**
   * Whether the derivatives already on the row were made from these bytes.
   *
   * Asked by a run that created no version — the same content arriving again.
   * The version file it would read is immutable (ADR-046), so an interpretation
   * of it cannot come out differently the second time, and a 50MB CSV would be
   * downloaded, run through DuckDB, written as Parquet and uploaded to arrive at
   * the file that is already there.
   *
   * A previous run that got partway through must still be finished, so every
   * part of this is a thing that could be missing: the preview key and a
   * `sourceHash` naming these bytes, `contentIndexed`, and no lake ingest still
   * outstanding for the version. The first two are written by the same run —
   * Interpret replaces the metadata and Index merges into it — so they never
   * describe two different contents.
   *
   * False whenever it cannot be sure. Skipping wrongly is the failure that says
   * nothing: a stale preview and a missing index both look like a healthy
   * resource.
   */
  derivativesDescribe(resourceId: string, contentHash: string, version: number): Promise<boolean>
  /**
   * Record what Interpret made of a version (ADR-046).
   *
   * Separate from the creation because the version is settled first: no schema
   * exists at that point, and one that never arrives is a normal state rather
   * than a lost write. Conditioned on the claim in its own statement, like the
   * insert it follows — the claim comes from the run-scoped context.
   */
  recordVersionSchema(opts: {
    resourceId: string
    version: number
    schema: ResourceSchema
    /** Why the schema is empty, when it is. Absent once a table came out. */
    noTableReason?: NoTableReason
    claim?: ResourceClaim
  }): Promise<void>
  /**
   * The active version holding exactly these bytes and not yet in DuckLake, or
   * null (ADR-043 layer 2).
   *
   * Asked every run, not only when a version was just created: a Lake step that
   * failed once would otherwise never retry — the next run finds the content
   * unchanged, creates none, and once a newer version exists the backfill
   * cannot reach the older one either, leaving that pair permanently undiffable.
   */
  pendingLakeVersion(resourceId: string, contentHash: string): Promise<number | null>
  /**
   * Layer 2 (ADR-043 Phase ii): load a created version's tabular content into
   * DuckLake from the table an interpretation produced, and record the snapshot
   * on the version row (ADR-046). Returns null when the context was built
   * without a DuckLake config.
   */
  ingestLakeVersion(opts: LakeIngestRow): Promise<IngestResult | null>
}
