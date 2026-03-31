/**
 * KUKAN Admin REST API Routes
 * /api/v1/admin endpoints (sysadmin only)
 */

import { Hono } from 'hono'
import { eq, and, inArray, sql } from 'drizzle-orm'
import {
  packageTable,
  resource,
  resourcePipeline,
  organization,
  group,
  packageGroup,
  packageTag,
  tag,
} from '@kukan/db'
import { ForbiddenError } from '@kukan/shared'
import type { DatasetDoc } from '@kukan/search-adapter'
import type { AppContext } from '../context'

export const adminRouter = new Hono<{ Variables: AppContext }>()

const BATCH_SIZE = 100

// POST /api/v1/admin/reindex — Rebuild search index from DB
adminRouter.post('/reindex', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can reindex')

  const db = c.get('db')
  const search = c.get('search')

  // Clear all existing documents to remove stale entries
  await search.deleteAll()

  // Fetch all active package IDs
  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let indexed = 0

  // Process in batches
  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE)

    const batchIds = batch.map((p) => p.id)

    // Batch queries: 5 queries per batch instead of 5 per package
    const [details, allResources, allGroups, allTags] = await Promise.all([
      db
        .select({
          id: packageTable.id,
          name: packageTable.name,
          title: packageTable.title,
          notes: packageTable.notes,
          ownerOrg: packageTable.ownerOrg,
          private: packageTable.private,
          creatorUserId: packageTable.creatorUserId,
          licenseId: packageTable.licenseId,
          created: packageTable.created,
          updated: packageTable.updated,
        })
        .from(packageTable)
        .where(inArray(packageTable.id, batchIds)),
      db
        .select({
          packageId: resource.packageId,
          id: resource.id,
          name: resource.name,
          description: resource.description,
          format: resource.format,
        })
        .from(resource)
        .where(and(inArray(resource.packageId, batchIds), eq(resource.state, 'active'))),
      db
        .select({ packageId: packageGroup.packageId, name: group.name })
        .from(packageGroup)
        .innerJoin(group, eq(packageGroup.groupId, group.id))
        .where(inArray(packageGroup.packageId, batchIds)),
      db
        .select({ packageId: packageTag.packageId, name: tag.name })
        .from(packageTag)
        .innerJoin(tag, eq(packageTag.tagId, tag.id))
        .where(inArray(packageTag.packageId, batchIds)),
    ])

    // Resolve organization names in bulk
    const orgIds = [...new Set(details.map((d) => d.ownerOrg).filter((id): id is string => !!id))]
    const orgMap = new Map<string, string>()
    if (orgIds.length > 0) {
      const orgs = await db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(inArray(organization.id, orgIds))
      for (const o of orgs) orgMap.set(o.id, o.name)
    }

    // Group by packageId in memory
    const resourcesByPkg = new Map<string, typeof allResources>()
    for (const r of allResources) {
      let arr = resourcesByPkg.get(r.packageId)
      if (!arr) {
        arr = []
        resourcesByPkg.set(r.packageId, arr)
      }
      arr.push(r)
    }
    const groupsByPkg = new Map<string, string[]>()
    for (const g of allGroups) {
      let arr = groupsByPkg.get(g.packageId)
      if (!arr) {
        arr = []
        groupsByPkg.set(g.packageId, arr)
      }
      arr.push(g.name)
    }
    const tagsByPkg = new Map<string, string[]>()
    for (const t of allTags) {
      let arr = tagsByPkg.get(t.packageId)
      if (!arr) {
        arr = []
        tagsByPkg.set(t.packageId, arr)
      }
      arr.push(t.name)
    }

    const docs: DatasetDoc[] = details.map((detail) => {
      const pkgResources = resourcesByPkg.get(detail.id) ?? []
      const formatSet = new Set(
        pkgResources.map((r) => r.format?.toUpperCase()).filter((f): f is string => !!f)
      )
      return {
        id: detail.id,
        name: detail.name,
        title: detail.title ?? undefined,
        notes: detail.notes ?? undefined,
        organization: detail.ownerOrg ? orgMap.get(detail.ownerOrg) : undefined,
        license_id: detail.licenseId ?? undefined,
        groups: groupsByPkg.get(detail.id) ?? [],
        tags: tagsByPkg.get(detail.id) ?? [],
        formats: [...formatSet],
        private: detail.private,
        owner_org_id: detail.ownerOrg ?? undefined,
        creator_user_id: detail.creatorUserId ?? undefined,
        created: detail.created,
        updated: detail.updated,
        resources: pkgResources.map((r) => ({
          id: r.id,
          name: r.name ?? undefined,
          description: r.description ?? undefined,
          format: r.format ?? undefined,
        })),
      }
    })

    if (docs.length > 0) {
      await search.bulkIndex(docs)
      indexed += docs.length
    }
  }

  return c.json({ indexed })
})

const RECENT_ERROR_LIMIT = 10

// GET /api/v1/admin/queue/stats — Queue and pipeline statistics
adminRouter.get('/queue/stats', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view queue stats')

  const db = c.get('db')
  const queue = c.get('queue')

  const [queueStats, statusCounts, recentErrors] = await Promise.all([
    queue.getStats(),
    db
      .select({
        status: resourcePipeline.status,
        count: sql<number>`count(*)::int`,
      })
      .from(resourcePipeline)
      .groupBy(resourcePipeline.status),
    db
      .select({
        resourceId: resourcePipeline.resourceId,
        resourceName: resource.name,
        error: resourcePipeline.error,
        updated: resourcePipeline.updated,
      })
      .from(resourcePipeline)
      .innerJoin(resource, eq(resourcePipeline.resourceId, resource.id))
      .where(eq(resourcePipeline.status, 'error'))
      .orderBy(sql`${resourcePipeline.updated} desc`)
      .limit(RECENT_ERROR_LIMIT),
  ])

  const statusMap: Record<string, number> = {}
  for (const row of statusCounts) {
    statusMap[row.status] = row.count
  }

  return c.json({
    queue: queueStats,
    jobs: statusMap,
    recentErrors,
  })
})
