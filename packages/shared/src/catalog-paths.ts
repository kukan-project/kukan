/**
 * The public pages' paths, for the web's links, its JSON-LD and the API's
 * sitemap — one spelling of each, so the sitemap cannot name a page the
 * site does not have.
 */

/**
 * Where the API renders the sitemap's XML. The web hands it its /sitemap.xml and
 * /sitemap/* in-process and proxies no other path to it; the content is public
 * only, so a deployment serving the API directly (ADR-012 headless) exposes nothing more.
 */
export const SITEMAP_BASE_PATH = '/internal/sitemap'

export function datasetPath(name: string): string {
  return `/dataset/${encodeURIComponent(name)}`
}

export function resourcePath(datasetName: string, resourceId: string): string {
  return `${datasetPath(datasetName)}/resource/${encodeURIComponent(resourceId)}`
}

export function organizationPath(name: string): string {
  return `/organization/${encodeURIComponent(name)}`
}

export function groupPath(name: string): string {
  return `/group/${encodeURIComponent(name)}`
}

/**
 * A tag's page. The whole name is one segment — `/` goes as `%2F`, read back
 * by the page's decoding; names that cannot be one are refused (`tagNameSchema`).
 * A `.` or `..` tag saved before that rule gets no page: its link resolves to
 * `/tag/` or `/`. Editing the dataset asks for the tag to go.
 */
export function tagPath(name: string): string {
  return `/tag/${encodeURIComponent(name)}`
}
