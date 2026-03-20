/**
 * KUKAN Pipeline Queue Handler
 * Registers the queue consumer that processes resource pipeline jobs.
 * Builds PipelineContext and delegates to processResource().
 */

import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource, packageTable } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { SearchAdapter } from '@kukan/search-adapter'
import { processResource } from '@kukan/pipeline'
import type { PipelineContext, ResourceForPipeline, PackageForIndex } from '@kukan/pipeline'
import { PIPELINE_JOB_TYPE } from '@kukan/shared'
import type { Job } from '@kukan/shared'

/**
 * Register the 'resource-pipeline' queue handler.
 * Called once during app startup.
 */
export async function registerPipelineHandler(
  db: Database,
  queue: QueueAdapter,
  storage: StorageAdapter,
  search: SearchAdapter
) {
  await queue.process<{ resourceId: string }>(
    PIPELINE_JOB_TYPE,
    async (job: Job<{ resourceId: string }>) => {
      const ctx = buildPipelineContext(db, storage, search)
      await processResource(job.data.resourceId, ctx, db)
    }
  )
}

/**
 * Build a PipelineContext from the app's adapters and database.
 */
export function buildPipelineContext(
  db: Database,
  storage: StorageAdapter,
  search: SearchAdapter
): PipelineContext {
  return {
    storage,
    search,

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

    async updateResourceHash(id: string, hash: string): Promise<void> {
      await db
        .update(resource)
        .set({ hash, lastModified: sql`NOW()` })
        .where(eq(resource.id, id))
    },

    async getPackageForIndex(packageId: string): Promise<PackageForIndex | null> {
      const [pkg] = await db
        .select({
          id: packageTable.id,
          name: packageTable.name,
          title: packageTable.title,
          notes: packageTable.notes,
          ownerOrg: packageTable.ownerOrg,
        })
        .from(packageTable)
        .where(eq(packageTable.id, packageId))
        .limit(1)

      if (!pkg) return null

      const resources = await db
        .select({
          id: resource.id,
          name: resource.name,
          description: resource.description,
          format: resource.format,
        })
        .from(resource)
        .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))

      return { ...pkg, resources }
    },
  }
}
