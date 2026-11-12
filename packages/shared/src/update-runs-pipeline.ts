import { normalizeFormat } from './formats'

/** The part of a resource a save can change that decides how its bytes are read */
export interface ResourceSource {
  url?: string | null
  urlType?: string | null
  format?: string | null
}

/**
 * Whether saving a resource from `before` to `after` should run its pipeline
 * (ADR-072 decision 6).
 *
 * Only the source and the format decide how the bytes are read, so only a
 * change to one of them runs it. A save that touches nothing but the name,
 * description or extras used to re-fetch a URL resource every time — and when
 * the remote file had moved on, renaming the resource published a version.
 *
 * **A switch to an upload waits for the file.** The editor saves first and
 * sends the file after; running here would read the previous contents under the
 * new source. The run comes from the upload's promotion instead, as it always
 * has for a new file.
 *
 * Shared by the API, which decides, and the editor, which has to know whether a
 * run is coming to show that it is.
 */
export function updateRunsPipeline(before: ResourceSource, after: ResourceSource): boolean {
  const formatChanged = !sameFormat(before.format, after.format)
  if (after.urlType === 'upload') {
    // Already an upload: the live object is there to read again
    return before.urlType === 'upload' && formatChanged
  }
  if (!after.url) return false
  return (
    (before.url ?? null) !== after.url ||
    (before.urlType ?? null) !== (after.urlType ?? null) ||
    formatChanged
  )
}

/** Formats compared as the API stores them — it normalizes the case on the way in */
function sameFormat(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (f: string | null | undefined) => (f ? normalizeFormat(f) : null)
  return norm(a) === norm(b)
}
