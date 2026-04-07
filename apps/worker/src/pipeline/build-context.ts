/**
 * Build PipelineContext from adapters and database.
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { PipelineContext, ResourceForPipeline } from './types'
import { FETCH_RATE_LIMIT_INTERVAL_MS } from '@/config'

export function buildPipelineContext(db: Database, storage: StorageAdapter): PipelineContext {
  return {
    storage,

    async getResource(id: string): Promise<ResourceForPipeline | null> {
      const [res] = await db
        .select({
          id: resource.id,
          packageId: resource.packageId,
          url: resource.url,
          urlType: resource.urlType,
          format: resource.format,
          hash: resource.hash,
        })
        .from(resource)
        .where(and(eq(resource.id, id), eq(resource.state, 'active')))
        .limit(1)

      return res ?? null
    },

    async updateResourceHashAndSize(
      id: string,
      meta: { hash: string; size: number }
    ): Promise<void> {
      await db
        .update(resource)
        .set({ hash: meta.hash, size: meta.size, lastModified: sql`NOW()` })
        .where(eq(resource.id, id))
    },

    async acquireFetchSlot(fqdn: string): Promise<boolean> {
      const result = await db.execute(sql`
        INSERT INTO fetch_rate_limit (fqdn, last_fetched_at)
        VALUES (${fqdn}, NOW())
        ON CONFLICT (fqdn) DO UPDATE
          SET last_fetched_at = NOW()
          WHERE fetch_rate_limit.last_fetched_at < NOW() - ${`${FETCH_RATE_LIMIT_INTERVAL_MS} milliseconds`}::interval
        RETURNING fqdn
      `)
      return result.rows.length > 0
    },
  }
}
