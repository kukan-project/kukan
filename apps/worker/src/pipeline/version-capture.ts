/**
 * Version capture policy (ADR-043, layer 1): whether to snapshot the resource's
 * canonical file as a new version, and as which number. The copy and the insert
 * are `PipelineContext.captureVersion`, which runs this under the lock.
 */

export type VersionResult = { captured: false } | { captured: true; version: number }

/**
 * Decide whether to capture, and as which version number.
 *
 * Kept separate from the IO so the rules that are easy to get wrong stay
 * testable: this run must still own the content, the gate compares against the
 * latest *active* hash rather than the highest row, and the number comes from
 * the highest row of *any* state.
 *
 * @param publishedKey - the object this run published.
 * @param currentKey - what the resource row names now, read under the capture
 *   lock. A mismatch means another run published while this one was between its
 *   publish and here; capturing would file this run's older bytes above the
 *   version that run captured, leaving the live content behind its own latest
 *   version. The lock is what makes the comparison decisive — nobody can move
 *   the pointer between it and the insert.
 * @param maxVersion - highest version across ALL rows, purged tombstones
 *   included, so the next number never collides on the unique index.
 * @param latestActiveHash - content hash of the highest-numbered active version.
 *   Distinct from maxVersion because a tombstone can sit above the live version
 *   (e.g. after a latest-version purge + rollback); gating on the max row would
 *   then re-capture content that is already the live version.
 */
export function decideVersionCapture(input: {
  hash: string
  publishedKey: string
  currentKey: string | null
  maxVersion: number | null
  latestActiveHash: string | null
}): VersionResult {
  if (input.currentKey !== input.publishedKey) return { captured: false }
  if (input.latestActiveHash === input.hash) return { captured: false }
  return { captured: true, version: (input.maxVersion ?? 0) + 1 }
}
