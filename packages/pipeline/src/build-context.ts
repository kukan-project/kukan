/**
 * Build PipelineContext from adapters and database.
 * Used by both the API (in-process mode) and the Worker (SQS mode).
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { PipelineContext, ResourceForPipeline } from './types'

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
  }
}
