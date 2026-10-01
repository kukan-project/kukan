import { eq } from 'drizzle-orm'
import { job } from '@kukan/db'
import { DROP_LAKE_TABLES_JOB_TYPE } from '@kukan/shared'
import { getTestDb } from './test-db'

/** The DuckLake drops queued for the worker, by payload. */
export async function queuedLakeDrops(): Promise<unknown[]> {
  const rows = await getTestDb()
    .select({ payload: job.payload })
    .from(job)
    .where(eq(job.type, DROP_LAKE_TABLES_JOB_TYPE))
  return rows.map((r) => r.payload)
}
