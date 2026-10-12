/**
 * The shared catalog layer 2 moved off (ADR-067 §6): its tables in the
 * `ducklake` schema, outside Drizzle, and its files under `lake/` outside any
 * resource's prefix (`lake/main/`). Nothing reads either; until they are
 * dropped, the rows of every version purged before the move are still in them
 * (§5). Dropped on an operator's word rather than by a migration, because it
 * also gives up rolling back to an image that used them.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { LAKE_DATA_PREFIX, LAKE_METADATA_SCHEMA, lakeResourceOfKey } from '@kukan/lake'
import { ConflictError } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { deleteAllLakeKeys, listLakeKeys } from './lake-catalog'
import { countUnmigratedLakeResources } from './lake-rebuild'

export interface SharedLakeCatalog {
  /** Resources whose versions are still only in it: the migration left to run */
  unmigrated: number
  /** Whether its schema is still in the database */
  schema: boolean
  /** Its files still in the bucket */
  files: string[]
}

/** What is left of the shared catalog, and of the migration off it. */
export async function inspectSharedLakeCatalog(
  db: Database,
  storage: Pick<StorageAdapter, 'list'>
): Promise<SharedLakeCatalog> {
  const [unmigrated, schema, keys] = await Promise.all([
    countUnmigratedLakeResources(db),
    db.execute(sql`SELECT 1 FROM pg_namespace WHERE nspname = ${LAKE_METADATA_SCHEMA}`),
    listLakeKeys(storage, LAKE_DATA_PREFIX),
  ])
  return {
    unmigrated,
    schema: schema.rows.length > 0,
    files: keys.filter((key) => lakeResourceOfKey(key) === null),
  }
}

/**
 * Delete the shared catalog's files, then its schema — in that order, so a run
 * cut short leaves the schema to say there is more to do. Refused while any
 * resource is still to be migrated: the migration reads layer 1 only, but
 * until it is done, rolling back is the only way to the history it has not
 * moved yet.
 *
 * @returns what there was, as {@link inspectSharedLakeCatalog} found it.
 */
export async function dropSharedLakeCatalog(
  db: Database,
  storage: Pick<StorageAdapter, 'list' | 'deleteMany'>
): Promise<SharedLakeCatalog> {
  const found = await inspectSharedLakeCatalog(db, storage)
  if (found.unmigrated > 0) {
    throw new ConflictError(
      `${found.unmigrated} resource(s) are still to be moved off the shared lake catalog`
    )
  }
  await deleteAllLakeKeys(storage, found.files, 'the shared lake catalog')
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${LAKE_METADATA_SCHEMA} CASCADE`))
  return found
}
