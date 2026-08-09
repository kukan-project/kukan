/**
 * In-memory handoff of a new dataset's first resources across client-side
 * navigation.
 *
 * Creating a dataset spans two routes: the new-dataset form creates the draft,
 * then the edit page's ResourceList adds the resources. Files can't ride the
 * URL, so both they and the urls typed beside them are stashed here by package
 * id and consumed once on the edit page's mount. A full page reload loses the
 * stash — same as any in-progress upload. If the handoff aborts after the draft
 * POST (navigation failure, tab closed), the already-created draft remains in
 * the drafts tab and is deleted manually per ADR-039.
 */
export interface PendingResources {
  files: File[]
  /** Singular because the page asks for one url; a second is added on the edit page */
  url: string | null
}

const pending = new Map<string, PendingResources>()

export function stashPendingResources(packageId: string, resources: PendingResources) {
  // Only one handoff is ever in flight — drop entries stranded by aborted ones
  pending.clear()
  pending.set(packageId, resources)
}

/** Returns and clears the stash — a second take yields nothing (StrictMode-safe) */
export function takePendingResources(packageId: string): PendingResources {
  const resources = pending.get(packageId) ?? { files: [], url: null }
  pending.delete(packageId)
  return resources
}
