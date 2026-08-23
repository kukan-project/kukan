/**
 * In-memory handoff of dropped files across client-side navigation.
 *
 * Creating a dataset by file drop spans two routes: the new-dataset form
 * creates the draft, then the edit page's ResourceList uploads the files as
 * resources. File objects can't ride the URL, so they are stashed here by
 * package id and consumed once on the edit page's mount. A full page reload
 * loses the stash — same as any in-progress upload. If the handoff aborts after
 * the draft POST (navigation failure, tab closed), the already-created draft
 * remains in the drafts tab and is deleted manually per ADR-039.
 *
 * Only files pass through here. A url is text the user still holds, so it is
 * typed on the edit page, where a failed one can be corrected in place.
 */
const pending = new Map<string, File[]>()

export function stashPendingDropFiles(packageId: string, files: File[]) {
  // Only one handoff is ever in flight — drop entries stranded by aborted ones
  pending.clear()
  pending.set(packageId, files)
}

/** Returns and clears the stash — a second take yields [] (StrictMode-safe) */
export function takePendingDropFiles(packageId: string): File[] {
  const files = pending.get(packageId) ?? []
  pending.delete(packageId)
  return files
}
