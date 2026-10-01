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
 * DuckLake tables are *not* dropped here: they are keyed by resource, not by
 * package, and the org purge drops the whole organization's tables in one
 * session rather than one per package. Callers pair this with
 * `dropResourceTables`, or queue it with the rows' deletion
 * (`queueLakeTablesDrop`) where they run in the web (ADR-043 layer 2).
 */

import { and, eq, exists, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion } from '@kukan/db'
import { RESOURCE_PREFIX, PREVIEW_PREFIX } from '@kukan/shared'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { SEARCH_DOC_SYNC_LOCK, withGlobalAdvisoryLock } from './advisory-lock'

/**
 * What a purge of these packages has to account for, read while the rows still
 * exist: every resource, so the purge can claim them (ADR-044), and the subset
 * whose content reached DuckLake, which names the tables that have to go with
 * them (ADR-043 layer 2).
 *
 * One query for both. They are the same rows read two ways, and a purge that
 * read them separately could see a resource enter the lake in between.
 *
 * Correlated through drizzle rather than written out — see CLAUDE.md; this
 * query is the reason the rule is there. Shape pinned in
 * `__tests__/services/sql-shape.integration.test.ts`.
 */
export async function listPurgeTargets(
  db: Database,
  packageIds: string[]
): Promise<{ resourceIds: string[]; lakeResourceIds: string[] }> {
  if (packageIds.length === 0) return { resourceIds: [], lakeResourceIds: [] }

  const rows = await db
    .select({
      id: resource.id,
      inLake: exists(
        db
          .select({})
          .from(resourceVersion)
          .where(
            and(
              eq(resourceVersion.resourceId, resource.id),
              isNotNull(resourceVersion.ducklakeSnapshotId)
            )
          )
      ),
    })
    .from(resource)
    .where(inArray(resource.packageId, packageIds))

  return {
    resourceIds: rows.map((r) => r.id),
    lakeResourceIds: rows.filter((r) => r.inLake).map((r) => r.id),
  }
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
 */
export async function purgePackagesSearchDocs(
  db: Database,
  packageIds: string[],
  search: SearchAdapter | undefined
): Promise<void> {
  if (!search || packageIds.length === 0) return
  await withGlobalAdvisoryLock(db, SEARCH_DOC_SYNC_LOCK, async () => {
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
