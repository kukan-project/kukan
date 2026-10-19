import { datasetPath, findLicense, groupPath, organizationPath } from '@kukan/shared'
import type { Package } from '@/components/dataset/dataset-detail-layout'
import { resourceDownloadPath } from './paths'

/**
 * A dataset as schema.org `Dataset`, the markup Google Dataset Search
 * reads from the page. Only facts the catalog holds — nothing is inferred.
 * Fields with no value are left undefined, which JSON.stringify drops.
 */
export function datasetJsonLd(pkg: Package, origin: string): Record<string, unknown> {
  const org = pkg.organization
  const publisher = org
    ? {
        '@type': 'Organization',
        name: org.title || org.name,
        url: origin + organizationPath(org.name),
      }
    : undefined
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: pkg.title || pkg.name,
    // Google requires one; a dataset with no description is named for what it is
    description: pkg.notes || pkg.title || pkg.name,
    url: origin + datasetPath(pkg.name),
    identifier: pkg.id,
    keywords: pkg.tags.length > 0 ? pkg.tags.map((t) => t.name) : undefined,
    license: (pkg.licenseId && findLicense(pkg.licenseId)?.url) || pkg.licenseId || undefined,
    creator: publisher,
    publisher,
    dateCreated: pkg.created,
    dateModified: pkg.updated,
    isAccessibleForFree: true,
    // The categories, as the subjects the dataset is about
    about:
      pkg.groups.length > 0
        ? pkg.groups.map((g) => ({
            '@type': 'Thing',
            name: g.title || g.name,
            url: origin + groupPath(g.name),
          }))
        : undefined,
    // Each file through the download link the page's button follows
    distribution: pkg.resources.map((r) => ({
      '@type': 'DataDownload',
      name: r.name || r.id,
      encodingFormat: r.format || undefined,
      contentUrl: origin + resourceDownloadPath(pkg.name, r.id, r.url || r.id),
    })),
  }
}

/** JSON for a `<script>`: `<` escaped so a value cannot close the element */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
