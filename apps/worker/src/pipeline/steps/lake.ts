/**
 * KUKAN Pipeline — Lake Step (ADR-043 layer 2, Phase ii-a)
 * Loads a newly captured tabular version into DuckLake so later versions can be
 * diffed row by row. Layer 1 (the canonical version file) is already durable by
 * the time this runs, and DuckLake is rebuildable from it, so this step is
 * advisory: skipping or failing it never costs data.
 *
 * The version to load is the one holding this run's content, so the Parquet
 * cannot be attributed to content it does not describe.
 *
 * Runs inside the interpretation (ADR-046): what it loads is the table that
 * interpretation just wrote to local disk. Which resources are tabular is
 * settled by that — a run producing no table never reaches this — so there is
 * no format test here.
 */

import type { LakeIngestRow } from '@kukan/api/services/lake-ingest'
import { RunCancelledError } from '../step-tracker'
import type { PipelineContext } from '../types'

/** `failed` carries what a retry needs; the caller queues it (ADR-043). */
export type LakeStepResult =
  | { status: 'ingested' }
  | { status: 'skipped' }
  | { status: 'failed'; version: number; error: Error }

/** `sourcePath` is documented on {@link LakeIngestRow}; the version is resolved
 *  here rather than given, from the hash below. */
export interface LakeStepOptions extends Omit<LakeIngestRow, 'version'> {
  /**
   * What Fetch measured on the version this interpreted. The version to ingest
   * is the one holding it, which is how a run that captured nothing still picks
   * up a version whose earlier ingest failed.
   */
  contentHash: string
}

export async function executeLake(
  opts: LakeStepOptions,
  ctx: PipelineContext
): Promise<LakeStepResult> {
  const { resourceId, sourcePath, contentHash } = opts

  const version = await ctx.pendingLakeVersion(resourceId, contentHash)
  if (version === null) return { status: 'skipped' }

  try {
    const result = await ctx.ingestLakeVersion({ resourceId, version, sourcePath })
    // null when the context carries no DuckLake config, or when something else
    // ingested this version first.
    return result === null ? { status: 'skipped' } : { status: 'ingested' }
  } catch (err) {
    // A kill is not this step failing. Treated as one, a stopped run would
    // have a retry queued for a version a revert has just decided against
    // (ADR-044 §4).
    if (err instanceof RunCancelledError) throw err
    // Nothing is recorded for the retry to follow. The version file is what
    // gets interpreted again, and "an active version with no snapshot" is the
    // whole of what makes this one findable (ADR-046 §4).
    return { status: 'failed', version, error: err as Error }
  }
}
