/** Draft packages are edited under an explicit state=draft query (ADR-039) */
export function draftEditPath(packageId: string) {
  return `/dashboard/datasets/${packageId}/edit?state=draft`
}
