/**
 * KUKAN Package External Cleanup
 *
 * Removes a package's external resources — its OpenSearch documents (metadata +
 * resource/content children) and its storage objects (raw files + previews).
 *
 * Shared so the single-package purge route and the worker's batch cleanup job
 * stay consistent. The DB rows are deleted by the caller (PackageService.purge
 * for one package, OrganizationService.purgeDeletedOrg's bulk delete for an org);
 * this helper only touches the external systems.
 */

import { RESOURCE_PREFIX, PREVIEW_PREFIX } from '@kukan/shared'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'

export async function purgePackageExternals(
  packageId: string,
  search: SearchAdapter | undefined,
  storage: StorageAdapter
): Promise<void> {
  // deletePackage removes the package doc and its resource/content children.
  // search is undefined when OpenSearch is not configured (nothing indexed).
  if (search) await search.deletePackage(packageId)
  await Promise.all([
    storage.deleteByPrefix(`${RESOURCE_PREFIX}${packageId}/`),
    storage.deleteByPrefix(`${PREVIEW_PREFIX}${packageId}/`),
  ])
}
