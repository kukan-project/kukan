/**
 * Version create policy (ADR-043, layer 1): whether the resource's canonical
 * file becomes a new version, and which number it takes. Owning the object and
 * recording the row are `PipelineContext.createVersion`, which runs this under
 * the run's claim.
 */

import { sameVersionIdentity } from '@kukan/shared'
import type { VersionIdentity } from '@kukan/shared'

export type VersionResult = { created: false } | { created: true; version: number }

/**
 * Decide whether to create, and as which version number.
 *
 * Kept separate from the IO so the rules that are easy to get wrong stay
 * testable: this run must still own the content, the gate compares against the
 * latest *active* version rather than the highest row, and the number comes from
 * the highest row of *any* state.
 *
 * The gate is the whole interpretation, not the bytes alone: a version is "these
 * bytes, read this way", so changing how they are read makes a version (ADR-046
 * §3, §6). Format is the part of that settled at creation, and without it a
 * corrected label would have nowhere to land — the bytes are unchanged, so no
 * create would happen, and the existing version would go on being read by the
 * rule the correction replaced. **The primary key is the same shape of input**
 * (spec §6.4): the version it would otherwise attach to has already been loaded
 * into layer 2 under the old key, and the diffs either side of a key change only
 * mean anything if the boundary is a version.
 *
 * @param identity - the reading this run is publishing: its own measurement of
 *   the bytes, and how the resource says they are to be read. Gated on the
 *   measurement rather than the row's, which describes whichever run published
 *   last; the object this run wrote is the one it measured and no one rewrites.
 * @param latestActive - the same three, as the highest-numbered active version
 *   froze them, or null when there is no active version to compare with. One
 *   object rather than three fields because the three always travel together —
 *   they are one version's reading, and a caller cannot have two of them.
 *
 *   Distinct from `maxVersion` because a tombstone can sit above the live
 *   version (e.g. after a latest-version purge + rollback); gating on the max
 *   row would then re-create content that is already the live version.
 * @param publishedKey - the object this run published.
 * @param currentKey - what the resource row names now. A mismatch means another
 *   run published while this one was between its publish and here; creating would
 *   file this run's older bytes above the version that run created, leaving the
 *   live content behind its own latest version. The claim is what makes the
 *   comparison decisive — no other run can move the pointer between it and the
 *   insert, and a run that lost the claim cannot insert at all (ADR-044 §4).
 * @param maxVersion - highest version across ALL rows, purged tombstones
 *   included, so the next number never collides on the unique index.
 * @param keyOwnedByPurgingVersion - whether the version that owns the object
 *   being published is on its way out. A version that owns it and is staying is
 *   the ordinary case, and `createVersion` copies the object so the two do not
 *   share one file. Copying content that is being purged is the thing to avoid:
 *   the copy is a version of its own, which the purge does not recognise, so
 *   what someone asked to have destroyed stays live under a new number. The
 *   active-set comparison below cannot see it — a claimed version has already
 *   left that set.
 */
export function decideVersionCreate(input: {
  identity: VersionIdentity
  latestActive: VersionIdentity | null
  publishedKey: string
  currentKey: string | null
  maxVersion: number | null
  keyOwnedByPurgingVersion: boolean
}): VersionResult {
  if (input.currentKey !== input.publishedKey) return { created: false }
  if (input.keyOwnedByPurgingVersion) return { created: false }
  // Through the shared definition, because a revert asks the same question of
  // the same two readings to decide whether a resend has anything left to do
  // (ADR-044 §4). Two spellings drift the day the identity gains a field.
  const settled =
    input.latestActive !== null && sameVersionIdentity(input.latestActive, input.identity)
  if (settled) return { created: false }
  return { created: true, version: (input.maxVersion ?? 0) + 1 }
}
