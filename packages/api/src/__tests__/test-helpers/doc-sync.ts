import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import { packageTable, type Transaction } from '@kukan/db'
import { SEARCH_DOC_SYNC_LOCK, lockInTransaction } from '../../services/advisory-lock'
import { getTestDb, getTestDatabaseUrl } from './test-db'

/** Run `take` in another transaction and hold what it took until the returned release */
export async function holdInTransaction(take: (tx: Transaction) => Promise<unknown>) {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let taken!: () => void
  const isTaken = new Promise<void>((r) => (taken = r))
  const holder = getTestDb().transaction(async (tx) => {
    await take(tx)
    taken()
    await held
  })
  await isTaken
  return async () => {
    release()
    await holder
  }
}

/** A sync holding the search document lock until the returned release */
export const holdDocSyncLock = () =>
  holdInTransaction((tx) => lockInTransaction(tx, SEARCH_DOC_SYNC_LOCK, ''))

/**
 * {@link holdDocSyncLock} on a connection of its own. The test pool has two:
 * with the holder and one waiter on them, anything else would wait for a
 * connection rather than for the lock.
 */
export async function holdDocSyncLockOffPool() {
  const client = new Client({ connectionString: getTestDatabaseUrl() })
  await client.connect()
  const own = drizzle(client)
  await own.execute(sql`BEGIN`)
  await lockInTransaction(own, SEARCH_DOC_SYNC_LOCK, '')
  return async () => {
    await own.execute(sql`COMMIT`)
    await client.end()
  }
}

/** A dataset's search-document mark: null once its document is written */
export async function packageDueAt(id: string) {
  const [row] = await getTestDb()
    .select({ d: packageTable.docSyncDueAt })
    .from(packageTable)
    .where(eq(packageTable.id, id))
  return row?.d
}
