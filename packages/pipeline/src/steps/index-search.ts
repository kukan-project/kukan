/**
 * KUKAN Pipeline — Index Step
 * Updates the search index with resource and package metadata
 */

import type { DatasetDoc } from '@kukan/shared'
import type { PipelineContext } from '../types'

/**
 * Build a DatasetDoc from resource/package data and index it in the search engine.
 * Always runs, regardless of Extract success.
 */
export async function indexSearchStep(resourceId: string, ctx: PipelineContext): Promise<void> {
  const res = await ctx.getResource(resourceId)
  if (!res) return

  const pkg = await ctx.getPackageForIndex(res.packageId)
  if (!pkg) return

  const doc: DatasetDoc = {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title ?? undefined,
    notes: pkg.notes ?? undefined,
    organization: pkg.ownerOrg ?? undefined,
    matchedResources: pkg.resources.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      description: r.description ?? undefined,
      format: r.format ?? undefined,
    })),
  }

  await ctx.search.index(doc)
}
