/**
 * KUKAN Package External Cleanup
 *
 * What every package purge has in common: the set of resources it is about to
 * erase, and the removal of their external traces — OpenSearch documents
 * (metadata + resource/content children) and storage objects (raw files,
 * previews, retained versions).
 *
 * Shared so the single-package purge, the draft purge and the org purge stay
 * consistent. The DB rows are deleted by the caller, since only it knows what
 * else goes with them.
 *
 * Layer 2 is *not* deleted here: it is keyed by resource, not by package
 * (`lake/<resourceId>/`, ADR-067). Callers pair this with
 * `deleteResourceLakes`, or queue it with the rows' deletion
 * (`queueResourceLakesDeletion`) where they run in the web.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource } from '@kukan/db'
import { ConflictError, RESOURCE_PREFIX, PREVIEW_PREFIX } from '@kukan/shared'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { SEARCH_DOC_SYNC_LOCK, withGlobalAdvisoryLock } from './concurrency/advisory-lock'

/**
 * What a purge of these packages has to account for, read while the rows still
 * exist: every resource, so the purge can claim them (ADR-044) and delete
 * their layer 2 — every one, since a resource whose first load failed can have
 * files there and no catalog.
 */
export async function listPurgeTargets(
  db: Pick<Database, 'select'>,
  packageIds: string[]
): Promise<{ resourceIds: string[] }> {
  if (packageIds.length === 0) return { resourceIds: [] }
  const rows = await db
    .select({ id: resource.id })
    .from(resource)
    .where(inArray(resource.packageId, packageIds))
  return { resourceIds: rows.map((r) => r.id) }
}

export async function purgePackageExternals(
  db: Database,
  packageId: string,
  deps: { search?: SearchAdapter; storage: StorageAdapter }
): Promise<void> {
  await purgePackagesSearchDocs(db, [packageId], deps.search)
  await purgePackageStorage(packageId, deps.storage)
}

/**
 * Remove the search documents of packages whose rows are going, with their
 * resource and content children. `search` is undefined when OpenSearch is not
 * configured (nothing indexed). Under the sync's lock, taken once for them
 * all: a writer that read a dataset before its row went cannot land the
 * document after this, and nothing is left marked to undo it.
 *
 * `whileState`, for a caller that removes the documents before the rows: the
 * packages are asked, under the lock, whether they are still in that state. A
 * restore committed before the check refuses the purge here, rather than
 * having its documents removed; one committed after it finds the lock held, and
 * writes them after this has finished.
 */
export async function purgePackagesSearchDocs(
  db: Database,
  packageIds: string[],
  search: SearchAdapter | undefined,
  opts: { whileState?: 'deleted' } = {}
): Promise<void> {
  if (!search || packageIds.length === 0) return
  await withGlobalAdvisoryLock(db, SEARCH_DOC_SYNC_LOCK, async (tx) => {
    if (opts.whileState) {
      const still = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(and(inArray(packageTable.id, packageIds), eq(packageTable.state, opts.whileState)))
      if (still.length < packageIds.length) {
        throw new ConflictError(
          `Package is no longer ${opts.whileState}`,
          undefined,
          'package-state-changed'
        )
      }
    }
    for (const id of packageIds) await search.deletePackage(id)
  })
}

/** Remove the storage objects of a package whose rows are going */
export async function purgePackageStorage(
  packageId: string,
  storage: StorageAdapter
): Promise<void> {
  await Promise.all([
    storage.deleteByPrefix(`${RESOURCE_PREFIX}${packageId}/`),
    storage.deleteByPrefix(`${PREVIEW_PREFIX}${packageId}/`),
  ])
}
