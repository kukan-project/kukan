/** Draft packages are edited under an explicit state=draft query (ADR-039) */
export function draftEditPath(packageId: string) {
  return `/dashboard/datasets/${packageId}/edit?state=draft`
}

/** The dashboard row a link from the public status view opens (see ResourceList) */
export function resourceEditPath(nameOrId: string, resourceId: string) {
  return `/dashboard/datasets/${encodeURIComponent(nameOrId)}/edit?resource=${encodeURIComponent(resourceId)}`
}
