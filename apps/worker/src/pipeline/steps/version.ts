/**
 * KUKAN Pipeline — Version Step (ADR-043, layer 1)
 * Captures an immutable copy of the resource's canonical file as a new version
 * when its content hash differs from the latest one. Format-agnostic.
 */

import { getVersionKey } from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import type { PipelineContext } from '../types'

export type VersionResult = { captured: false } | { captured: true; version: number }

/**
 * Capture a new version of a resource's canonical file if its content changed.
 *
 * The copy of version vN is made while the current key still holds vN's bytes,
 * so a later overwrite by v(N+1) never affects the already-copied versions/.../vN.
 *
 * @param currentStorageKey - the resource's live key (holds the just-fetched content)
 * @param schema - column schema from Extract (CSV/TSV only), snapshotted onto the version
 */
export async function executeVersion(
  resourceId: string,
  packageId: string,
  currentStorageKey: string,
  schema: ResourceSchema | null,
  ctx: PipelineContext
): Promise<VersionResult> {
  const res = await ctx.getResource(resourceId)

  // Without a content hash there is nothing to gate on or attribute — skip.
  if (!res || !res.hash) {
    return { captured: false }
  }

  const { maxVersion, latestActiveHash } = await ctx.getVersionCaptureInfo(resourceId)

  // Change gate: skip when the latest active version already holds this content.
  // Compares against the latest *active* hash (not the max row), so a rollback
  // that restores an older version's bytes doesn't spawn a spurious new version.
  if (latestActiveHash !== null && latestActiveHash === res.hash) {
    return { captured: false }
  }

  const next = (maxVersion ?? 0) + 1
  const versionKey = getVersionKey(packageId, resourceId, next)

  await ctx.storage.copy(currentStorageKey, versionKey)
  await ctx.insertResourceVersion({
    resourceId,
    version: next,
    storageKey: versionKey,
    size: res.size,
    hash: res.hash,
    origin: res.urlType === 'upload' ? 'upload' : 'fetch',
    schema,
  })

  return { captured: true, version: next }
}
