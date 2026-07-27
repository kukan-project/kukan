/**
 * Version capture policy (ADR-043, layer 1): whether to snapshot the resource's
 * canonical file as a new version, and as which number. The copy and the insert
 * are `PipelineContext.captureVersion`, which runs this under the lock.
 */

export type VersionResult = { captured: false } | { captured: true; version: number }

/**
 * Decide whether to capture, and as which version number.
 *
 * Kept separate from the IO so the two rules that are easy to get wrong stay
 * testable: the gate compares against the latest *active* hash rather than the
 * highest row, and the number comes from the highest row of *any* state.
 *
 * @param maxVersion - highest version across ALL rows, purged tombstones
 *   included, so the next number never collides on the unique index.
 * @param latestActiveHash - content hash of the highest-numbered active version.
 *   Distinct from maxVersion because a tombstone can sit above the live version
 *   (e.g. after a latest-version purge + rollback); gating on the max row would
 *   then re-capture content that is already the live version.
 */
export function decideVersionCapture(input: {
  hash: string
  maxVersion: number | null
  latestActiveHash: string | null
}): VersionResult {
  if (input.latestActiveHash === input.hash) return { captured: false }
  return { captured: true, version: (input.maxVersion ?? 0) + 1 }
}
