/**
 * KUKAN Pipeline — Lake Step (ADR-043 layer 2, Phase ii-a)
 * Loads a newly captured tabular version into DuckLake so later versions can be
 * diffed row by row. Layer 1 (the canonical version file) is already durable by
 * the time this runs, and DuckLake is rebuildable from it, so this step is
 * advisory: skipping or failing it never costs data.
 *
 * The version to load is the one holding this run's content, so the Parquet
 * cannot be attributed to content it does not describe — and a version whose
 * earlier ingest failed is picked up again on any later run that produces the
 * same preview.
 */

import { isLakeIngestable } from '@kukan/lake'
import type { PipelineContext } from '../types'

/**
 * @param previewKey - the Extract output. Null for resources with no preview,
 *   and non-Parquet for the ones layer 2 does not cover (a ZIP's JSON
 *   manifest); both are skipped rather than handed to `read_parquet`.
 * @param contentHash - what Fetch measured on the object Extract parsed. The
 *   version to ingest is the one holding it, which is how a run that captured
 *   nothing still retries a version whose earlier ingest failed.
 */
export async function executeLake(
  resourceId: string,
  previewKey: string | null,
  contentHash: string,
  ctx: PipelineContext
): Promise<{ ingested: boolean }> {
  if (!isLakeIngestable(previewKey)) return { ingested: false }

  const version = await ctx.pendingLakeVersion(resourceId, contentHash)
  if (version === null) return { ingested: false }

  const result = await ctx.ingestLakeVersion({ resourceId, version, previewKey })
  // null when the pipeline context carries no DuckLake config.
  return { ingested: result !== null }
}
