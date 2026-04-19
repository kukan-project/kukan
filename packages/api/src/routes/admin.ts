/**
 * KUKAN Admin REST API Routes
 * /api/v1/admin endpoints (sysadmin only)
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, ne, and, inArray, isNull, ilike, or, sql, desc } from 'drizzle-orm'
import {
  packageTable,
  resource,
  resourcePipeline,
  organization,
  group,
  packageGroup,
  packageTag,
  tag,
  vocabulary,
  user,
  session,
  apiToken,
} from '@kukan/db'
import {
  ForbiddenError,
  RESOURCE_PREFIX,
  PREVIEW_PREFIX,
  escapeLike,
  userNameSchema,
  userRoleSchema,
} from '@kukan/shared'
import type { DatasetDoc, ResourceDoc } from '@kukan/search-adapter'
import { PipelineService } from '../services/pipeline-service'
import type { AppContext } from '../context'

export const adminRouter = new Hono<{ Variables: AppContext }>()

const BATCH_SIZE = 100
const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 100

/** Parse offset / limit / status query params shared by paginated admin endpoints */
function parsePaginatedQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
  const limit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT) || DEFAULT_PAGE_LIMIT)
  )
  const statusParam = c.req.query('status')
  const statusList = statusParam ? statusParam.split(',').filter(Boolean) : undefined
  return { offset, limit, statusList }
}

/** Build standard paginated response from rows containing a `total` window column */
function toPaginatedResponse<T extends { total: number }>(
  rows: T[],
  offset: number,
  limit: number
) {
  return {
    items: rows.map(({ total: _, ...rest }) => rest),
    total: rows[0]?.total ?? 0,
    offset,
    limit,
  }
}

/** WHERE conditions for external-URL resources (urlType IS NULL, active, url IS NOT NULL) */
const externalUrlConditions = [
  isNull(resource.urlType),
  eq(resource.state, 'active'),
  sql`${resource.url} IS NOT NULL`,
]

// GET /api/v1/admin/search/stats — Index statistics
adminRouter.get('/search/stats', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view search stats')

  const stats = await c.get('search').getIndexStats()
  return c.json({ enabled: stats !== null, stats })
})

// GET /api/v1/admin/search/doc/:index/:id — Get a single document from OpenSearch
adminRouter.get('/search/doc/:index/:id', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view search documents')

  const index = c.req.param('index')
  if (index !== 'packages' && index !== 'resources') {
    return c.json(
      { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Invalid index' },
      400
    )
  }

  const doc = await c.get('search').getDocument(index, c.req.param('id'))
  if (!doc)
    return c.json(
      { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Document not found' },
      404
    )
  return c.json(doc)
})

// GET /api/v1/admin/search/browse/:index — Browse/search documents in an index
adminRouter.get('/search/browse/:index', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can browse search index')

  const index = c.req.param('index')
  if (index !== 'packages' && index !== 'resources') {
    return c.json(
      { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Invalid index' },
      400
    )
  }

  const q = c.req.query('q') ?? ''
  const offset = parseInt(c.req.query('offset') ?? '0', 10)
  const limit = parseInt(c.req.query('limit') ?? '20', 10)

  const result = await c.get('search').browseDocuments(index, { q, offset, limit })
  if (!result)
    return c.json(
      {
        type: 'about:blank',
        title: 'Not Available',
        status: 404,
        detail: 'OpenSearch not enabled',
      },
      404
    )
  return c.json(result)
})

// POST /api/v1/admin/reindex — Rebuild search index from DB
adminRouter.post('/reindex', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can reindex')

  const db = c.get('db')
  const search = c.get('search')

  // Clear all existing documents to remove stale entries
  await Promise.all([search.deleteAllPackages(), search.deleteAllResources()])

  // Fetch all active package IDs
  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let indexed = 0
  let resourcesIndexed = 0

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

    // Build dataset docs (without resources — they go to kukan-resources)
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
      }
    })

    // Build resource docs (metadata only — content is added by pipeline)
    const resourceDocs: ResourceDoc[] = allResources.map((r) => ({
      id: r.id,
      packageId: r.packageId,
      name: r.name ?? undefined,
      description: r.description ?? undefined,
      format: r.format ?? undefined,
    }))

    if (docs.length > 0) {
      await search.bulkIndexPackages(docs)
      indexed += docs.length
    }
    if (resourceDocs.length > 0) {
      await search.bulkIndexResources(resourceDocs)
      resourcesIndexed += resourceDocs.length
    }
  }

  return c.json({ indexed, resourcesIndexed })
})

// POST /api/v1/admin/jobs/enqueue-all — Enqueue pipeline for all active resources
adminRouter.post('/jobs/enqueue-all', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can enqueue all pipelines')

  const db = c.get('db')
  const pipelineService = new PipelineService(db, c.get('queue'))

  // Fetch all active resource IDs
  const resources = await db
    .select({ id: resource.id })
    .from(resource)
    .where(eq(resource.state, 'active'))

  let enqueued = 0

  for (let i = 0; i < resources.length; i += BATCH_SIZE) {
    const batch = resources.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map((r) => pipelineService.enqueue(r.id).catch(() => {})))
    enqueued += batch.length
  }

  return c.json({ enqueued })
})

const RECENT_ERROR_LIMIT = 10

// GET /api/v1/admin/jobs/stats — Pipeline job statistics
adminRouter.get('/jobs/stats', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view job stats')

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

// GET /api/v1/admin/jobs — Paginated pipeline job list
adminRouter.get('/jobs', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view jobs')

  const db = c.get('db')
  const { offset, limit, statusList } = parsePaginatedQuery(c)

  const statusOrder = sql`CASE ${resourcePipeline.status}
    WHEN 'processing' THEN 0
    WHEN 'queued' THEN 1
    WHEN 'pending' THEN 2
    WHEN 'complete' THEN 3
    ELSE 4
  END`

  const whereClause = statusList?.length ? inArray(resourcePipeline.status, statusList) : undefined

  const rows = await db
    .select({
      id: resourcePipeline.id,
      resourceId: resourcePipeline.resourceId,
      status: resourcePipeline.status,
      error: resourcePipeline.error,
      created: resourcePipeline.created,
      updated: resourcePipeline.updated,
      resourceName: resource.name,
      packageId: resource.packageId,
      packageName: packageTable.name,
      packageTitle: packageTable.title,
      total: sql<number>`COUNT(*) OVER()::int`.as('total'),
    })
    .from(resourcePipeline)
    .innerJoin(resource, eq(resourcePipeline.resourceId, resource.id))
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    .where(whereClause)
    .orderBy(statusOrder, desc(resourcePipeline.updated))
    .limit(limit)
    .offset(offset)

  return c.json(toPaginatedResponse(rows, offset, limit))
})

// DELETE /api/v1/admin/data — Delete all data (preserves users)
adminRouter.delete('/data', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can reset data')

  const db = c.get('db')
  const search = c.get('search')
  const storage = c.get('storage')

  // 1. Delete all data in a transaction (rollback on failure)
  const counts = await db.transaction(async (tx) => {
    const pkgs = await tx.delete(packageTable).returning({ id: packageTable.id })
    const orgs = await tx.delete(organization).returning({ id: organization.id })
    const grps = await tx.delete(group).returning({ id: group.id })
    const tgs = await tx.delete(tag).returning({ id: tag.id })
    await tx.delete(vocabulary)
    return {
      packages: pkgs.length,
      organizations: orgs.length,
      groups: grps.length,
      tags: tgs.length,
    }
  })

  // 2. Clear search index (best-effort)
  await Promise.all([
    search.deleteAllPackages().catch(() => {}),
    search.deleteAllResources().catch(() => {}),
  ])

  // 3. Clear storage files (best-effort)
  let storageObjects = 0
  try {
    const [r, p] = await Promise.all([
      storage.deleteByPrefix(RESOURCE_PREFIX),
      storage.deleteByPrefix(PREVIEW_PREFIX),
    ])
    storageObjects = r + p
  } catch {
    // Storage cleanup is best-effort
  }

  return c.json({ deleted: { ...counts, storageObjects } })
})

// GET /api/v1/admin/health/stats — Health check statistics for URL resources
adminRouter.get('/health/stats', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view health stats')

  const db = c.get('db')

  const rows = await db
    .select({
      status: resource.healthStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(resource)
    .where(and(...externalUrlConditions))
    .groupBy(resource.healthStatus)

  const statusMap: Record<string, number> = {}
  for (const row of rows) {
    statusMap[row.status ?? 'unknown'] = row.count
  }

  return c.json(statusMap)
})

// GET /api/v1/admin/health — Paginated health check resource list
adminRouter.get('/health', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view health checks')

  const db = c.get('db')
  const { offset, limit, statusList } = parsePaginatedQuery(c)

  const statusOrder = sql`CASE ${resource.healthStatus}
    WHEN 'error' THEN 0
    WHEN 'unknown' THEN 1
    ELSE 2
  END`

  const conditions = [...externalUrlConditions]
  if (statusList?.length) {
    conditions.push(inArray(resource.healthStatus, statusList))
  }

  const rows = await db
    .select({
      id: resource.id,
      url: resource.url,
      name: resource.name,
      healthStatus: resource.healthStatus,
      healthCheckedAt: resource.healthCheckedAt,
      extras: resource.extras,
      packageId: resource.packageId,
      packageName: packageTable.name,
      packageTitle: packageTable.title,
      total: sql<number>`COUNT(*) OVER()::int`.as('total'),
    })
    .from(resource)
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    .where(and(...conditions))
    .orderBy(statusOrder, sql`${resource.healthCheckedAt} DESC NULLS LAST`)
    .limit(limit)
    .offset(offset)

  return c.json(toPaginatedResponse(rows, offset, limit))
})

// ---------------------------------------------------------------------------
// User Management
// ---------------------------------------------------------------------------

// GET /api/v1/admin/users/stats — User count statistics
adminRouter.get('/users/stats', async (c) => {
  const currentUser = c.get('user')
  if (!currentUser?.sysadmin) throw new ForbiddenError('Only sysadmin can view user stats')

  const db = c.get('db')

  const rows = await db
    .select({
      state: user.state,
      role: user.role,
      count: sql<number>`count(*)::int`,
    })
    .from(user)
    .groupBy(user.state, user.role)

  let total = 0
  let active = 0
  let sysadmin = 0
  let deleted = 0
  for (const row of rows) {
    total += row.count
    if (row.state === 'active') active += row.count
    if (row.state === 'active' && row.role === 'sysadmin') sysadmin += row.count
    if (row.state === 'deleted') deleted += row.count
  }

  return c.json({ total, active, sysadmin, deleted })
})

// GET /api/v1/admin/users — Paginated user list with optional search
adminRouter.get('/users', async (c) => {
  const currentUser = c.get('user')
  if (!currentUser?.sysadmin) throw new ForbiddenError('Only sysadmin can view users')

  const db = c.get('db')
  const { offset, limit } = parsePaginatedQuery(c)
  const q = c.req.query('q')

  const conditions = []
  if (q) {
    const pattern = `%${escapeLike(q)}%`
    conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern)))
  }

  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      state: user.state,
      createdAt: user.createdAt,
      total: sql<number>`COUNT(*) OVER()::int`.as('total'),
    })
    .from(user)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json(toPaginatedResponse(rows, offset, limit))
})

// POST /api/v1/admin/users — Create a new user
adminRouter.post(
  '/users',
  zValidator(
    'json',
    z.object({
      name: userNameSchema,
      email: z.string().email().max(200),
      password: z.string().min(8),
      role: userRoleSchema.default('user'),
    })
  ),
  async (c) => {
    const currentUser = c.get('user')
    if (!currentUser?.sysadmin) throw new ForbiddenError('Only sysadmin can create users')

    const auth = c.get('auth')
    const body = c.req.valid('json')

    const result = await auth.api.createUser({
      body: {
        name: body.name,
        email: body.email,
        password: body.password,
        ...(body.role === 'sysadmin' && { role: 'sysadmin' as const }),
      },
    })

    if (!result) {
      return c.json(
        { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'Failed to create user' },
        400
      )
    }

    return c.json(result, 201)
  }
)

// PATCH /api/v1/admin/users/:userId — Update user (name, displayName, role)
adminRouter.patch(
  '/users/:userId',
  zValidator(
    'json',
    z.object({
      name: userNameSchema.optional(),
      displayName: z.string().max(200).optional(),
      role: userRoleSchema.optional(),
    })
  ),
  async (c) => {
    const currentUser = c.get('user')
    if (!currentUser?.sysadmin) throw new ForbiddenError('Only sysadmin can update users')

    const userId = c.req.param('userId')
    const body = c.req.valid('json')

    // Prevent self-demotion (sysadmin lockout)
    if (userId === currentUser.id && body.role === 'user') {
      return c.json(
        {
          type: 'about:blank',
          title: 'BAD_REQUEST',
          status: 400,
          detail: 'Cannot demote yourself',
        },
        400
      )
    }

    const db = c.get('db')

    // Check name uniqueness
    if (body.name) {
      const [existing] = await db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.name, body.name), ne(user.id, userId)))
        .limit(1)
      if (existing) {
        return c.json(
          {
            type: 'about:blank',
            title: 'CONFLICT',
            status: 409,
            detail: 'Username already taken',
          },
          409
        )
      }
    }

    const updates: Partial<Pick<typeof user.$inferInsert, 'name' | 'displayName' | 'role'>> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.displayName !== undefined) updates.displayName = body.displayName
    if (body.role !== undefined) updates.role = body.role

    if (Object.keys(updates).length === 0) {
      return c.json(
        { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'No fields to update' },
        400
      )
    }

    const [updated] = await db
      .update(user)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(user.id, userId))
      .returning({
        id: user.id,
        name: user.name,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        state: user.state,
      })

    if (!updated) {
      return c.json(
        { type: 'about:blank', title: 'Not Found', status: 404, detail: 'User not found' },
        404
      )
    }

    return c.json(updated)
  }
)

// DELETE /api/v1/admin/users/:userId — Soft-delete user
adminRouter.delete('/users/:userId', async (c) => {
  const currentUser = c.get('user')
  if (!currentUser?.sysadmin) throw new ForbiddenError('Only sysadmin can delete users')

  const userId = c.req.param('userId')

  // Prevent self-deletion
  if (userId === currentUser.id) {
    return c.json(
      {
        type: 'about:blank',
        title: 'BAD_REQUEST',
        status: 400,
        detail: 'Cannot delete yourself',
      },
      400
    )
  }

  const db = c.get('db')

  // 1. Soft-delete: set state to 'deleted'
  const [deleted] = await db
    .update(user)
    .set({ state: 'deleted', updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ id: user.id })

  if (!deleted) {
    return c.json(
      { type: 'about:blank', title: 'Not Found', status: 404, detail: 'User not found' },
      404
    )
  }

  // 2. Revoke all sessions and API tokens (immediate logout)
  await Promise.all([
    db.delete(session).where(eq(session.userId, userId)),
    db.delete(apiToken).where(eq(apiToken.userId, userId)),
  ])

  return c.json({ success: true })
})
