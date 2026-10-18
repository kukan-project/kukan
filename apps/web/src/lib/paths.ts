export function datasetEditPath(packageId: string) {
  return `/dashboard/datasets/${packageId}/edit`
}

/** Draft packages are edited under an explicit state=draft query (ADR-039) */
export function draftEditPath(packageId: string) {
  return `${datasetEditPath(packageId)}?state=draft`
}

/** The dashboard row a link from the public status view opens (see ResourceList) */
export function resourceEditPath(nameOrId: string, resourceId: string) {
  return `/dashboard/datasets/${encodeURIComponent(nameOrId)}/edit?resource=${encodeURIComponent(resourceId)}`
}

/**
 * A tag's page. The whole name is one segment — `/` goes as `%2F`, read back
 * by the page's decoding; names that cannot be one are refused (`tagNameSchema`).
 * A `.` or `..` tag saved before that rule gets no page: its link resolves to
 * `/tag/` or `/`. Editing the dataset asks for the tag to go.
 */
export function tagPath(name: string) {
  return `/tag/${encodeURIComponent(name)}`
}
