/**
 * What settles a version, in one place (ADR-046 §3).
 *
 * A version is "these bytes, read this way", so two things are the same
 * version's worth of content only when the bytes *and* the reading match. Two
 * callers ask that question and they must not answer it differently:
 *
 * - the pipeline's create gate, deciding whether content that arrived is a new
 *   version
 * - a revert, deciding whether a resend is already at the destination it named
 *   (ADR-044 §4)
 *
 * **Spelled as a field list, the second one goes stale silently.** ii-b adds the
 * primary key as a third input — the key is part of the interpretation, so
 * changing it makes a version (spec §6.4) — and a settled rule still comparing
 * hash and format would then answer "already there" for a destination that
 * differs only in its key, leaving the interpretation unrestored with nothing
 * failing. Adding the field here changes both answers at once.
 */
export interface VersionIdentity {
  hash: string | null
  /**
   * The label the bytes are read under. Compared as stored: `normalizeFormat`
   * has settled the case on the way in, so a difference here is one a reader
   * would act on.
   */
  format: string | null
}

/**
 * How each input is compared, one entry per field.
 *
 * **The mapped type is what makes the promise above true.** Written as
 * `a.hash === b.hash && a.format === b.format`, adding a field to
 * {@link VersionIdentity} would leave that expression compiling and quietly
 * ignoring it — the stale comparison this module exists to prevent, in one
 * place instead of two. Here a new field is a missing key, which is an error.
 *
 * It also leaves room for the fields that cannot use `===`: ii-b's key columns
 * are an array, and comparing those by reference would answer "different" for
 * every version.
 */
const COMPARE: {
  [K in keyof VersionIdentity]-?: (a: VersionIdentity[K], b: VersionIdentity[K]) => boolean
} = {
  hash: (a, b) => a === b,
  format: (a, b) => a === b,
}

/** Whether two readings of content describe the same version's worth of it. */
export function sameVersionIdentity(a: VersionIdentity, b: VersionIdentity): boolean {
  return (Object.keys(COMPARE) as (keyof VersionIdentity)[]).every((field) =>
    // Each comparator is typed against its own field; the key walk loses that,
    // and re-establishing it needs a generic helper for no gain in safety.
    (COMPARE[field] as (x: unknown, y: unknown) => boolean)(a[field], b[field])
  )
}
