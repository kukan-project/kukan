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
 * `dropResourceTables` (ADR-043 layer 2).
 */

import { and, eq, exists, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, resourceVersion } from '@kukan/db'
import { RESOURCE_PREFIX, PREVIEW_PREFIX } from '@kukan/shared'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'

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
  packageId: string,
  deps: { search?: SearchAdapter; storage: StorageAdapter }
): Promise<void> {
  // deletePackage removes the package doc and its resource/content children.
  // search is undefined when OpenSearch is not configured (nothing indexed).
  if (deps.search) await deps.search.deletePackage(packageId)
  await Promise.all([
    deps.storage.deleteByPrefix(`${RESOURCE_PREFIX}${packageId}/`),
    deps.storage.deleteByPrefix(`${PREVIEW_PREFIX}${packageId}/`),
  ])
}
