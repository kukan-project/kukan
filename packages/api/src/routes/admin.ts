/**
 * KUKAN Admin REST API Routes
 * /api/v1/admin endpoints (sysadmin only)
 */

import { Hono, type Context } from 'hono'
import { zValidator } from '../middleware/validator'
import { z } from 'zod'
import { eq, ne, and, inArray, isNull, ilike, or, sql, desc } from 'drizzle-orm'
import {
  packageTable,
  resource,
  resourcePipeline,
  organization,
  group,
  tag,
  vocabulary,
  user,
  auditLog,
} from '@kukan/db'
import { embeddingKey } from '@kukan/ai-adapter'
import { DEFAULT_VECTOR_MIN_SIMILARITY } from '@kukan/search-adapter'
import {
  ForbiddenError,
  UnauthorizedError,
  REINDEX_JOB_TYPE,
  BACKFILL_VERSIONS_JOB_TYPE,
  RESOURCE_PREFIX,
  PREVIEW_PREFIX,
  VERSION_PREFIX,
  escapeLike,
  userNameSchema,
  userRoleSchema,
} from '@kukan/shared'
import { PipelineService } from '../services/pipeline-service'
import { LAKE_DATA_PREFIX, LAKE_METADATA_SCHEMA } from '@kukan/lake'
import { ResourceVersionService } from '../services/resource-version-service'
import { UserService } from '../services/user-service'
import {
  VECTOR_SIMILARITY_NOTCHES_KEY,
  SEMANTIC_SEARCH_ENABLED_KEY,
  AI_SUGGEST_MODEL_KEY,
  AI_SUGGEST_ENABLED_KEY,
  SETTING_KEYS,
  isSettingKey,
  parseSettingValue,
} from '../services/system-setting'
import {
  VECTOR_SIMILARITY_STEP,
  VECTOR_SIMILARITY_MAX_NOTCHES,
  AI_SUGGEST_TEST_TIMEOUT_MS,
} from '../config'
import { classifyCompletionError } from '../services/suggest/diagnose'
import { resolveEffectiveModel } from '../services/suggest/availability'
import type { AppContext } from '../context'

export const adminRouter = new Hono<{ Variables: AppContext }>()

// All admin endpoints require sysadmin role — enforced at the router level
adminRouter.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Sysadmin role required')
  await next()
})

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

// GET /api/v1/admin/search/stats — Index statistics (OpenSearch + DB counts)
adminRouter.get('/search/stats', async (c) => {
  const db = c.get('db')

  const [stats, pkgCountRows, resCountRows] = await Promise.all([
    c.get('search').getIndexStats(),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(packageTable)
      .where(eq(packageTable.state, 'active')),
    // Resources under draft packages are excluded to match what the search
    // index holds (ADR-039)
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(resource)
      .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
      .where(and(eq(resource.state, 'active'), eq(packageTable.state, 'active'))),
  ])

  return c.json({
    enabled: stats !== null,
    stats,
    db: { packages: pkgCountRows[0]?.count ?? 0, resources: resCountRows[0]?.count ?? 0 },
  })
})

// GET /api/v1/admin/search/doc/:index/:id — Get a single document from OpenSearch
adminRouter.get('/search/doc/:index/:id', async (c) => {
  const index = c.req.param('index')
  if (index !== 'packages' && index !== 'resources' && index !== 'contents') {
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

// GET /api/v1/admin/search/chunks/:resourceId — List content chunks for a resource
adminRouter.get('/search/chunks/:resourceId', async (c) => {
  const resourceId = c.req.param('resourceId')
  const search = c.get('search')

  const chunks = await search.getContentChunks(resourceId)
  return c.json({ items: chunks })
})

// GET /api/v1/admin/search/browse/:index — Browse/search documents in an index
adminRouter.get('/search/browse/:index', async (c) => {
  const index = c.req.param('index')
  if (index !== 'packages' && index !== 'resources' && index !== 'contents') {
    return c.json(
      { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Invalid index' },
      400
    )
  }

  const q = c.req.query('q') ?? ''
  const offset = parseInt(c.req.query('offset') ?? '0', 10)
  const limit = parseInt(c.req.query('limit') ?? '20', 10)

  const search = c.get('search')

  // Contents tab uses a dedicated grouped-by-resource response
  if (index === 'contents') {
    const result = await search.browseContentsByResource({ q, offset, limit })
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
  }

  const result = await search.browseDocuments(index, { q, offset, limit })
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

// ---------------------------------------------------------------------------
// Runtime System Settings (ADR-036)
// Generic value API driven by the registry in services/system-setting.ts —
// adding a setting needs no new route. Only the context GETs (vector-search /
// ai-suggest) are bespoke: they fuse adapter capabilities with settings.
// ---------------------------------------------------------------------------

/** Round away float artifacts from base + notches × step */
const roundSimilarity = (value: number) => Math.round(value * 1000) / 1000

async function buildVectorSearchSettings(c: Context<{ Variables: AppContext }>) {
  const env = c.get('env')
  const settings = c.get('settings')
  const info = c.get('ai').getEmbeddingInfo()
  const [notches, semanticEnabled] = await Promise.all([
    settings.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY),
    settings.getSetting(SEMANTIC_SEARCH_ENABLED_KEY),
  ])
  const recommended = info?.recommendedMinSimilarity
  // Mirrors the floor precedence baked into the adapter (see adapters.ts)
  const base = env.SEARCH_VECTOR_MIN_SIMILARITY ?? recommended ?? DEFAULT_VECTOR_MIN_SIMILARITY
  return {
    enabled: info !== null && typeof c.get('dbSearch').searchByVector === 'function',
    model: info ? embeddingKey(info) : null,
    semanticEnabled,
    baseMinSimilarity: base,
    baseSource:
      env.SEARCH_VECTOR_MIN_SIMILARITY != null
        ? ('env' as const)
        : recommended != null
          ? ('model' as const)
          : ('default' as const),
    notches,
    step: VECTOR_SIMILARITY_STEP,
    maxNotches: VECTOR_SIMILARITY_MAX_NOTCHES,
    effectiveMinSimilarity: roundSimilarity(
      Math.min(1, Math.max(0, base + notches * VECTOR_SIMILARITY_STEP))
    ),
  }
}

async function auditSettingChange(
  c: Context<{ Variables: AppContext }>,
  key: string,
  value: unknown,
  write: { id: string; previous: unknown }
) {
  await c
    .get('db')
    .insert(auditLog)
    .values({
      entityType: 'system_setting',
      entityId: write.id,
      action: 'update',
      userId: c.get('user')!.id,
      changes: { key, value, previous: write.previous ?? null },
    })
}

// GET /api/v1/admin/settings/vector-search — Vector-search context (read-only)
adminRouter.get('/settings/vector-search', async (c) => {
  return c.json(await buildVectorSearchSettings(c))
})

async function buildAiSuggestSettings(c: Context<{ Variables: AppContext }>) {
  const settings = c.get('settings')
  const ai = c.get('ai')
  const info = ai.getCompletionInfo()
  const [model, suggestEnabled, availableModels] = await Promise.all([
    settings.getSetting(AI_SUGGEST_MODEL_KEY),
    settings.getSetting(AI_SUGGEST_ENABLED_KEY),
    // Best-effort model list for the picker; empty falls back to free-text
    info ? ai.listCompletionModels().catch(() => []) : Promise.resolve([]),
  ])
  return {
    enabled: info !== null,
    provider: info?.provider ?? null,
    defaultModel: info?.defaultModel ?? null,
    model,
    effectiveModel: info ? resolveEffectiveModel(info, model) : null,
    suggestEnabled,
    availableModels,
  }
}

// GET /api/v1/admin/settings/ai-suggest — AI-suggest context (read-only)
adminRouter.get('/settings/ai-suggest', async (c) => {
  return c.json(await buildAiSuggestSettings(c))
})

// POST /api/v1/admin/settings/ai-suggest/test — Try one tiny completion so an
// unpulled / unentitled model ID surfaces here instead of on first user click.
// Failures are 200 + ok:false so the admin UI can render the message inline.
adminRouter.post('/settings/ai-suggest/test', async (c) => {
  const context = await buildAiSuggestSettings(c)
  if (!context.enabled || !context.effectiveModel) {
    return c.json(
      {
        type: 'about:blank',
        title: 'Not Available',
        status: 400,
        detail: 'AI completion is not available (AI_TYPE=none)',
      },
      400
    )
  }

  const startedAt = Date.now()
  try {
    const raw = await c.get('ai').complete('Reply with {"ok": true}.', {
      model: context.effectiveModel,
      maxTokens: 100,
      timeoutMs: AI_SUGGEST_TEST_TIMEOUT_MS,
      jsonSchema: {
        name: 'connection_test',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    })
    // The completion resolving is not enough: an endpoint that ignores the JSON
    // schema returns prose/empty/malformed output that the real suggestion flow
    // would reject with a 503. Verify it actually produced the expected JSON.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        'The model did not return valid JSON — the endpoint may be ignoring the JSON schema (structured output).'
      )
    }
    if ((parsed as { ok?: unknown } | null)?.ok !== true) {
      throw new Error('The model response did not match the expected JSON ({"ok": true}).')
    }
    return c.json({ ok: true, model: context.effectiveModel, latencyMs: Date.now() - startedAt })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({
      ok: false,
      model: context.effectiveModel,
      latencyMs: Date.now() - startedAt,
      error: message,
      // Actionable setup hint for known provider errors (null → raw message only)
      code: classifyCompletionError(context.provider, message),
    })
  }
})

// GET /api/v1/admin/settings — Current value of every registered setting
adminRouter.get('/settings', async (c) => {
  const settings = c.get('settings')
  const entries = await Promise.all(
    SETTING_KEYS.map(async (key) => [key, await settings.getSetting(key)])
  )
  return c.json(Object.fromEntries(entries))
})

// PUT /api/v1/admin/settings/:key — Set one setting, validated by its registry schema
adminRouter.put(
  '/settings/:key',
  zValidator('json', z.object({ value: z.unknown() })),
  async (c) => {
    const key = c.req.param('key')
    if (!isSettingKey(key)) {
      return c.json(
        { type: 'about:blank', title: 'Not Found', status: 404, detail: `Unknown setting: ${key}` },
        404
      )
    }

    const parsed = parseSettingValue(key, c.req.valid('json').value)
    if (!parsed.success) {
      // Issue messages only — the raw ZodError JSON is unreadable in the admin UI
      const detail = parsed.error.issues.map((issue) => issue.message).join('; ')
      return c.json({ type: 'about:blank', title: 'Bad Request', status: 400, detail }, 400)
    }

    const write = await c.get('settings').setSetting(key, parsed.data)
    await auditSettingChange(c, key, parsed.data, write)

    return c.json({ key, value: parsed.data })
  }
)

// POST /api/v1/admin/reindex-metadata — Enqueue metadata rebuild job to Worker
adminRouter.post(
  '/reindex-metadata',
  zValidator('json', z.object({ includeContent: z.boolean().optional() }).default({})),
  async (c) => {
    const search = c.get('search')
    const stats = await search.getIndexStats()
    if (!stats) {
      return c.json(
        {
          type: 'about:blank',
          title: 'Not Available',
          status: 400,
          detail: 'OpenSearch not enabled',
        },
        400
      )
    }

    const { includeContent } = c.req.valid('json')
    const queue = c.get('queue')
    await queue.enqueue(REINDEX_JOB_TYPE, { includeContent })
    return c.json({ queued: true })
  }
)

// GET /api/v1/admin/version-backfill-status — Migration work still outstanding.
// Drives the one-time "backfill versions" control (ADR-043): the UI shows the
// action while either count is above zero. `unversionedCount` is layer 1
// (resources with no version at all), `pendingLakeIngestCount` is layer 2
// (tabular current versions not yet in DuckLake).
adminRouter.get('/version-backfill-status', async (c) => {
  const service = new ResourceVersionService(c.get('db'))
  const [unversionedCount, pendingLakeIngestCount] = await Promise.all([
    service.countUnversioned(),
    service.countPendingLakeIngest(),
  ])
  return c.json({ unversionedCount, pendingLakeIngestCount })
})

// POST /api/v1/admin/backfill-versions — Enqueue the one-time version backfill.
// Snapshots each unversioned resource's live file as v1 and loads current
// tabular versions into DuckLake (no re-fetch/re-index).
adminRouter.post('/backfill-versions', async (c) => {
  await c.get('queue').enqueue(BACKFILL_VERSIONS_JOB_TYPE, {})
  return c.json({ queued: true })
})

// POST /api/v1/admin/jobs/enqueue-all — Enqueue pipeline for all active resources
adminRouter.post('/jobs/enqueue-all', async (c) => {
  const db = c.get('db')
  const search = c.get('search')
  const pipelineService = new PipelineService(db, c.get('queue'))

  // Clear stale content (deleted resources, format changes) before re-processing.
  // Per-resource content is also cleaned in the pipeline Index step.
  await search.deleteAllContents()
  const result = await pipelineService.enqueueAll()

  return c.json(result)
})

const RECENT_ERROR_LIMIT = 10

// GET /api/v1/admin/jobs/stats — Pipeline job statistics
adminRouter.get('/jobs/stats', async (c) => {
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
    const [r, p, v, l] = await Promise.all([
      storage.deleteByPrefix(RESOURCE_PREFIX),
      storage.deleteByPrefix(PREVIEW_PREFIX),
      // Retained versions and DuckLake data files belong to the deleted rows too.
      storage.deleteByPrefix(VERSION_PREFIX),
      storage.deleteByPrefix(LAKE_DATA_PREFIX),
    ])
    storageObjects = r + p + v + l
  } catch {
    // Storage cleanup is best-effort
  }

  // 4. Drop the DuckLake catalog (best-effort). Its tables described the data
  // just deleted; leaving them would strand snapshots pointing at removed files.
  try {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${LAKE_METADATA_SCHEMA} CASCADE`))
  } catch {
    // Catalog cleanup is best-effort
  }

  return c.json({ deleted: { ...counts, storageObjects } })
})

// GET /api/v1/admin/health/stats — Health check statistics for URL resources
adminRouter.get('/health/stats', async (c) => {
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
      email: z.email().max(200),
      password: z.string().min(8),
      displayName: z.string().max(200).optional(),
      role: userRoleSchema.default('user'),
    })
  ),
  async (c) => {
    const auth = c.get('auth')
    const body = c.req.valid('json')

    const result = await auth.api.createUser({
      body: {
        name: body.name,
        email: body.email,
        password: body.password,
        ...(body.role === 'sysadmin' && { role: 'sysadmin' as const }),
        // Extra columns flow through Better Auth's `data` passthrough
        ...(body.displayName && { data: { displayName: body.displayName } }),
      },
    })

    if (!result) {
      return c.json(
        { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'Failed to create user' },
        400
      )
    }

    const created = result.user
    return c.json(
      { id: created.id, name: created.name, email: created.email, role: created.role },
      201
    )
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
    const currentUser = c.get('user')!
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
  const currentUser = c.get('user')!
  const userId = c.req.param('userId')
  if (userId === currentUser.id) {
    return c.json(
      { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'Cannot delete yourself' },
      400
    )
  }

  const service = new UserService(c.get('db'))
  await service.delete(userId)
  return c.json({ success: true })
})

// POST /api/v1/admin/users/:userId/restore — Restore a soft-deleted user
adminRouter.post('/users/:userId/restore', async (c) => {
  const currentUser = c.get('user')!
  const userId = c.req.param('userId')
  if (userId === currentUser.id) {
    return c.json(
      { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'Cannot restore yourself' },
      400
    )
  }

  const service = new UserService(c.get('db'))
  await service.restore(userId)
  return c.json({ success: true })
})

// POST /api/v1/admin/users/:userId/purge — Permanently delete a soft-deleted user
adminRouter.post('/users/:userId/purge', async (c) => {
  const currentUser = c.get('user')!
  const userId = c.req.param('userId')
  if (userId === currentUser.id) {
    return c.json(
      { type: 'about:blank', title: 'BAD_REQUEST', status: 400, detail: 'Cannot purge yourself' },
      400
    )
  }

  const service = new UserService(c.get('db'))
  await service.purge(userId, currentUser.id)
  return c.json({ success: true })
})

// ---------------------------------------------------------------------------
// Analytics (GA4 Data API)
// ---------------------------------------------------------------------------

const ANALYTICS_NOT_CONFIGURED = {
  type: 'about:blank',
  title: 'Not Configured',
  status: 404,
  detail:
    'GA4 analytics is not configured. Set GA4_PROPERTY_ID and GA4_CLIENT_EMAIL and GA4_PRIVATE_KEY environment variables.',
} as const

/** Parse date range + pagination for analytics endpoints */
function parseAnalyticsQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const { offset, limit } = parsePaginatedQuery(c)
  const startDate = c.req.query('startDate') ?? '30daysAgo'
  const endDate = c.req.query('endDate') ?? 'today'
  return { offset, limit, startDate, endDate }
}

// GET /api/v1/admin/analytics/dataset-views
adminRouter.get('/analytics/dataset-views', async (c) => {
  const analytics = c.get('analytics')
  if (!analytics) return c.json(ANALYTICS_NOT_CONFIGURED, 404)

  const { startDate, endDate, offset, limit } = parseAnalyticsQuery(c)
  const result = await analytics.getDatasetViews(startDate, endDate, offset, limit)
  return c.json({ ...result, offset, limit })
})

// GET /api/v1/admin/analytics/resource-views
adminRouter.get('/analytics/resource-views', async (c) => {
  const analytics = c.get('analytics')
  if (!analytics) return c.json(ANALYTICS_NOT_CONFIGURED, 404)

  const { startDate, endDate, offset, limit } = parseAnalyticsQuery(c)
  const result = await analytics.getResourceViews(startDate, endDate, offset, limit)
  return c.json({ ...result, offset, limit })
})

// GET /api/v1/admin/analytics/downloads
adminRouter.get('/analytics/downloads', async (c) => {
  const analytics = c.get('analytics')
  if (!analytics) return c.json(ANALYTICS_NOT_CONFIGURED, 404)

  const { startDate, endDate, offset, limit } = parseAnalyticsQuery(c)
  const result = await analytics.getDownloads(startDate, endDate, offset, limit)
  return c.json({ ...result, offset, limit })
})

// GET /api/v1/admin/analytics/search-terms
adminRouter.get('/analytics/search-terms', async (c) => {
  const analytics = c.get('analytics')
  if (!analytics) return c.json(ANALYTICS_NOT_CONFIGURED, 404)

  const { startDate, endDate, offset, limit } = parseAnalyticsQuery(c)
  const result = await analytics.getSearchTerms(startDate, endDate, offset, limit)
  return c.json({ ...result, offset, limit })
})
