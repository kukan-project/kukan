import { resourcePath } from '@kukan/shared'

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

export { datasetPath, groupPath, organizationPath, resourcePath, tagPath } from '@kukan/shared'

/** The last segment of a URL's path, or the string itself when it is no URL */
export function extractFilename(urlOrFilename: string): string {
  try {
    const url = new URL(urlOrFilename)
    const segments = url.pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] || urlOrFilename
  } catch {
    return urlOrFilename
  }
}

/** A resource's CKAN-compatible download permalink; the filename is cosmetic */
export function resourceDownloadPath(
  datasetNameOrId: string,
  resourceId: string,
  filename: string
) {
  return `${resourcePath(datasetNameOrId, resourceId)}/download/${encodeURIComponent(extractFilename(filename))}`
}
