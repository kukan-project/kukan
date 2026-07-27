/**
 * Preview objects a newer pipeline run replaced (ADR-043).
 *
 * Preview keys are unique per run, so replacing one orphans the old object
 * rather than overwriting it. It cannot be deleted at that moment: a request
 * resolves `preview_key` from the database and only then reads the object, so
 * one that resolved the old key is still reading it — across several Range
 * requests for a Parquet. The key is parked on the pipeline row by the same
 * statement that moves the pointer, and the hourly sweep deletes it once the
 * retention window has passed.
 *
 * Deletion lives only in the sweep. The pipeline could drain the list too, but
 * that would put storage round trips on the path to Extract and give the same
 * rule two implementations.
 */

/**
 * How long a replaced preview is kept. Wall-clock rather than "until the next
 * run", which for a resource that is never processed again is never.
 */
export const PREVIEW_RETENTION_MS = 60 * 60 * 1000

/**
 * Parked entries one resource may accumulate before the sweep starts deleting
 * the oldest early. Reaching it needs hundreds of runs of that resource inside
 * the retention window — a loop — and by then bounding the row matters more
 * than the last minutes of anyone's read.
 */
export const PREVIEW_PARKED_LIMIT = 200

export interface SupersededPreview {
  key: string
  at: number
}

/** Previews earlier runs replaced and the sweep has not deleted yet. */
export function pendingPreviewsOf(metadata: unknown): SupersededPreview[] {
  const raw = (metadata as { supersededPreviews?: unknown } | null)?.supersededPreviews
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is SupersededPreview =>
      !!e &&
      typeof (e as SupersededPreview).key === 'string' &&
      typeof (e as SupersededPreview).at === 'number'
  )
}

/**
 * Entries this sweep should delete: those past their retention, plus — once a
 * resource has parked more than {@link PREVIEW_PARKED_LIMIT} — the oldest of
 * the rest, so a run loop or a storage outage cannot grow one JSONB row without
 * bound. Oldest first either way: they are nearest their deadline.
 */
export function dueForDeletion(pending: SupersededPreview[], now: number): SupersededPreview[] {
  const byAge = [...pending].sort((a, b) => a.at - b.at)
  // Both reasons take a prefix of the oldest, so the answer is the longer one.
  const expired = byAge.filter((e) => now - e.at >= PREVIEW_RETENTION_MS).length
  const overflow = Math.max(0, byAge.length - PREVIEW_PARKED_LIMIT)
  return byAge.slice(0, Math.max(expired, overflow))
}

/**
 * Delete the given entries, returning the keys that are gone.
 *
 * Only those are dropped from tracking; one whose deletion failed stays parked
 * so a later sweep retries it, rather than becoming an object nothing knows
 * about. Everything due goes in one pass — a partial pass would let a resource
 * parking faster than the sweep deletes grow forever. `remove` carries the
 * sweep's own concurrency limit, so the bound is shared across resources rather
 * than multiplied by them.
 */
export async function deletePreviews(
  entries: SupersededPreview[],
  remove: (key: string) => Promise<void>
): Promise<string[]> {
  const results = await Promise.allSettled(entries.map((e) => remove(e.key)))
  return entries.filter((_, i) => results[i].status === 'fulfilled').map((e) => e.key)
}
