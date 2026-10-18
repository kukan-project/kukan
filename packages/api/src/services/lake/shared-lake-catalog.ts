/**
 * The shared catalog layer 2 moved off (ADR-067 §6): its tables in the
 * `ducklake` schema, outside Drizzle, and its files under `lake/` outside any
 * resource's prefix (`lake/main/`). Nothing reads either; until they are
 * dropped, the rows of every version purged before the move are still in them
 * (§5). Dropped by an operator's command rather than a migration, because it
 * deletes from the bucket as well as the database.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { LAKE_DATA_PREFIX, LAKE_METADATA_SCHEMA, lakeResourceOfKey } from '@kukan/lake'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { deleteAllLakeKeys, listLakeKeys } from './lake-catalog'

export interface SharedLakeCatalog {
  /** Whether its schema is still in the database */
  schema: boolean
  /** Its files still in the bucket */
  files: string[]
}

/** What is left of the shared catalog. */
export async function inspectSharedLakeCatalog(
  db: Database,
  storage: Pick<StorageAdapter, 'list'>
): Promise<SharedLakeCatalog> {
  const [schema, keys] = await Promise.all([
    db.execute(sql`SELECT 1 FROM pg_namespace WHERE nspname = ${LAKE_METADATA_SCHEMA}`),
    listLakeKeys(storage, LAKE_DATA_PREFIX),
  ])
  return {
    schema: schema.rows.length > 0,
    files: keys.filter((key) => lakeResourceOfKey(key) === null),
  }
}

/**
 * Delete the shared catalog's files, then its schema — in that order, so a run
 * cut short leaves the schema to say there is more to do. Nothing waits on
 * the migration off it: that reads layer 1 only, and with
 * `ducklake_snapshot_id` gone no image reads the shared catalog.
 *
 * @returns what there was, as {@link inspectSharedLakeCatalog} found it.
 */
export async function dropSharedLakeCatalog(
  db: Database,
  storage: Pick<StorageAdapter, 'list' | 'deleteMany'>
): Promise<SharedLakeCatalog> {
  const found = await inspectSharedLakeCatalog(db, storage)
  await deleteAllLakeKeys(storage, found.files, 'the shared lake catalog')
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${LAKE_METADATA_SCHEMA} CASCADE`))
  return found
}
