/**
 * KUKAN Pipeline — Lake Step (ADR-043 layer 2, Phase ii-a)
 * Loads a newly captured tabular version into DuckLake so later versions can be
 * diffed row by row. Layer 1 (the canonical version file) is already durable by
 * the time this runs, and DuckLake is rebuildable from it, so this step is
 * advisory: skipping or failing it never costs data.
 *
 * The version to load is the one holding this run's content, so the Parquet
 * cannot be attributed to content it does not describe.
 */

import { isLakeIngestable } from '@kukan/lake'
import type { PipelineContext } from '../types'

/** `failed` carries what a retry needs; the caller queues it (ADR-043). */
export type LakeStepResult =
  | { status: 'ingested' }
  | { status: 'skipped' }
  | { status: 'failed'; version: number; error: Error }

/**
 * @param previewKey - the Extract output. Null for resources with no preview,
 *   and non-Parquet for the ones layer 2 does not cover (a ZIP's JSON
 *   manifest); both are skipped rather than handed to `read_parquet`.
 * @param contentHash - what Fetch measured on the object Extract parsed. The
 *   version to ingest is the one holding it, which is how a run that captured
 *   nothing still picks up a version whose earlier ingest failed.
 */
export async function executeLake(
  resourceId: string,
  previewKey: string | null,
  contentHash: string,
  ctx: PipelineContext
): Promise<LakeStepResult> {
  if (!isLakeIngestable(previewKey)) return { status: 'skipped' }

  const version = await ctx.pendingLakeVersion(resourceId, contentHash)
  if (version === null) return { status: 'skipped' }

  const row = { resourceId, version, previewKey }
  try {
    const result = await ctx.ingestLakeVersion(row)
    // null when the context carries no DuckLake config, or when something else
    // ingested this version first.
    return result === null ? { status: 'skipped' } : { status: 'ingested' }
  } catch (err) {
    // Recorded before the caller queues anything: the pointer is what the
    // preview survives on, and what makes this version findable again.
    await ctx.deferLakeIngest(row)
    return { status: 'failed', version, error: err as Error }
  }
}
