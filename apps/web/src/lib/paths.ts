import { resourcePath } from '@kukan/shared'

/**
 * The dataset editor (ADR-072 decision 1). Addressed by the id: the editor sits
 * beside `/dashboard/datasets/new`, and a dataset named `new` would resolve to
 * the creation page.
 */
export function datasetEditPath(packageId: string) {
  return `/dashboard/datasets/${encodeURIComponent(packageId)}`
}

/**
 * The `?state=` an editor address carries on. The package API answers `active`
 * unless told to look at a draft (ADR-039) or a deleted dataset, so those two
 * travel from link to link; anything else is dropped.
 */
export function editorStateQuery(state: string | null | undefined): string {
  return state === 'draft' || state === 'deleted' ? `?state=${state}` : ''
}

const DATASET_LIST_KEY = 'kukan:dashboard-dataset-list'
/** The dashboard's dataset list, unfiltered */
export const DATASET_LIST = '/dashboard/datasets'

/**
 * Keep the dataset list's address as it was last seen — its view, filters and
 * page — for the editor's way back to it. Per tab (sessionStorage), and
 * nothing breaks without it: storage that refuses just means the plain list.
 */
export function rememberDatasetList(href: string): void {
  try {
    sessionStorage.setItem(DATASET_LIST_KEY, href)
  } catch {
    // Private windows and blocked storage: the way back is the plain list
  }
}

/** The dataset list as it was last seen in this tab, or the plain list */
export function recallDatasetList(): string {
  try {
    const href = sessionStorage.getItem(DATASET_LIST_KEY)
    // Only ever the list itself: storage is not a place to take an address from
    if (href && (href === DATASET_LIST || href.startsWith(`${DATASET_LIST}?`))) return href
  } catch {
    // As above
  }
  return DATASET_LIST
}

/** Draft packages are edited under an explicit state=draft query (ADR-039) */
export function draftEditPath(packageId: string) {
  return `${datasetEditPath(packageId)}?state=draft`
}

/** A resource's page in the dataset editor (ADR-072 decision 1) */
export function resourceEditPath(nameOrId: string, resourceId: string) {
  return `${datasetEditPath(nameOrId)}/resources/${encodeURIComponent(resourceId)}`
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

/**
 * A resource's URL when it points at another site — an upload's names our own.
 *
 * Tested by exclusion because `upload` is the only value the validator admits
 * (`createResourceBodySchema`); anything else, `null` included, is a fetch.
 */
export function externalUrl(
  resource: { url?: string | null; urlType?: string | null } | undefined
): string | null {
  return resource && resource.urlType !== 'upload' ? (resource.url ?? null) : null
}

/**
 * Whether a dataset's files are kept away from third-party viewers such as
 * Office Online: anything a reader without an account could not open.
 */
export function keepsFilesPrivate(pkg: { private?: boolean; state?: string | null }): boolean {
  return pkg.private === true || pkg.state === 'draft' || pkg.state === 'deleted'
}

/**
 * The Parquet the interpretation wrote of a resource, for the table readers.
 * `as=table` because a workbook's own preview address serves its original.
 */
export function tablePreviewUrl(resourceId: string): string {
  return `/api/v1/resources/${encodeURIComponent(resourceId)}/preview?as=table`
}
