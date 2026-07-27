/**
 * KUKAN Package External Cleanup
 *
 * Removes a package's external resources — its OpenSearch documents (metadata +
 * resource/content children) and its storage objects (raw files, previews, and
 * retained versions).
 *
 * Shared so the single-package purge route and the worker's batch cleanup job
 * stay consistent. The DB rows are deleted by the caller (PackageService.purge
 * for one package, OrganizationService.purgeDeletedOrg's bulk delete for an org);
 * this helper only touches the external systems.
 *
 * DuckLake tables are *not* handled here: they are keyed by resource, not by
 * package, and the org purge drops the whole organization's tables in one
 * session rather than one per package. Callers pair this with
 * `dropResourceTables` (ADR-043 layer 2).
 */

import { RESOURCE_PREFIX, PREVIEW_PREFIX, VERSION_PREFIX } from '@kukan/shared'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'

export async function purgePackageExternals(
  packageId: string,
  deps: { search?: SearchAdapter; storage: StorageAdapter }
): Promise<void> {
  // deletePackage removes the package doc and its resource/content children.
  // search is undefined when OpenSearch is not configured (nothing indexed).
  if (deps.search) await deps.search.deletePackage(packageId)
  await Promise.all([
    deps.storage.deleteByPrefix(`${RESOURCE_PREFIX}${packageId}/`),
    deps.storage.deleteByPrefix(`${PREVIEW_PREFIX}${packageId}/`),
    // Retained versions (ADR-043 layer 1) sit under their own prefix. Without
    // this they outlive the rows that reference them — unreachable, unbilled to
    // anyone, and still holding the content the purge was meant to destroy.
    deps.storage.deleteByPrefix(`${VERSION_PREFIX}${packageId}/`),
  ])
}
