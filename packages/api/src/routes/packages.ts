/**
 * KUKAN Packages REST API Routes
 * /api/v1/packages endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { PackageService } from '../services/package-service'
import { ResourceService } from '../services/resource-service'
import { PipelineService } from '../services/pipeline-service'
import {
  createPackageSchema,
  updatePackageSchema,
  patchPackageSchema,
  createResourceBodySchema,
  reorderResourcesSchema,
  ForbiddenError,
} from '@kukan/shared'
import type { MatchedResource, SearchFilters } from '@kukan/search-adapter'
import { checkOrgRole, resolveUserOrgIds, buildVisibilityFilters } from '../auth/permissions'
import { indexPackage } from '../services/search-index'
import type { AppContext } from '../context'

export const packagesRouter = new Hono<{ Variables: AppContext }>()

const stateParam = z.enum(['active', 'deleted']).optional()

// Repeated query param: normalizes string | string[] → string[] | undefined
const repeatedParam = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).filter(Boolean)))

// GET /api/v1/packages - List packages with pagination and search
packagesRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      q: z.string().optional(),
      name: z.string().optional(),
      organization: repeatedParam,
      groups: repeatedParam,
      tags: repeatedParam,
      res_format: repeatedParam,
      license_id: repeatedParam,
      creator_user_id: z.string().optional(),
      state: stateParam,
      my_org: z
        .string()
        .optional()
        .transform((val) => val === 'true'),
      private: z
        .string()
        .optional()
        .transform((val) => (val === 'true' ? true : val === 'false' ? false : undefined)),
      include_facets: z
        .string()
        .optional()
        .transform((val) => val === 'true'),
      sort_by: z.enum(['updated', 'created', 'name']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
    })
  ),
  async (c) => {
    const { my_org, tags, res_format, include_facets, state, sort_by, sort_order, ...rest } =
      c.req.valid('query')
    const db = c.get('db')
    const service = new PackageService(db)
    const user = c.get('user')

    // state=deleted is only allowed when my_org=true AND user is authenticated
    const effectiveState = state === 'deleted' && my_org && user ? 'deleted' : 'active'

    // Resolve user's org memberships (for visibility and my_org filters)
    const userOrgIds = await resolveUserOrgIds(db, user)

    // my_org=true with no memberships → guaranteed empty result
    if (my_org && userOrgIds !== undefined && userOrgIds.length === 0) {
      return c.json({ items: [], total: 0, offset: rest.offset, limit: rest.limit })
    }

    // Build visibility + access filters for SearchAdapter
    const filters: SearchFilters = {
      name: rest.name,
      organizations: rest.organization,
      tags,
      formats: res_format,
      licenses: rest.license_id,
      groups: rest.groups,
      ...buildVisibilityFilters(user, userOrgIds),
      // my_org filter
      ...(my_org && userOrgIds?.length && { ownerOrgIds: userOrgIds }),
      // Explicit filters
      ...(rest.private !== undefined && { isPrivate: rest.private }),
      ...(rest.creator_user_id && { creatorUserId: rest.creator_user_id }),
      state: effectiveState,
    }

    // Dashboard (my_org=true) uses PostgreSQL adapter for DB consistency
    const search = my_org ? c.get('dbSearch') : c.get('search')
    const searchResult = await search.search({
      q: rest.q ?? '',
      offset: rest.offset,
      limit: rest.limit,
      filters,
      facets: include_facets,
      sortBy: sort_by,
      sortOrder: sort_order,
    })

    // Build matchedResources lookup from search results
    const searchMatchedResources: Record<string, MatchedResource[]> = {}
    for (const item of searchResult.items) {
      if (item.matchedResources && item.matchedResources.length > 0) {
        searchMatchedResources[item.id] = item.matchedResources
      }
    }

    // SearchAdapter handles visibility + name filter; service.list only does DB enrichment
    const result = await service.list({
      searchMatchIds: searchResult.items.map((i) => i.id),
      searchTotal: searchResult.total,
      searchMatchedResources,
      state: effectiveState,
    })

    if (include_facets && searchResult.facets) {
      const facets = await service.enrichFacets(searchResult.facets)
      return c.json({ ...result, facets })
    }
    return c.json(result)
  }
)

// POST /api/v1/packages - Create new package (org editor+)
packagesRouter.post('/', zValidator('json', createPackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const input = c.req.valid('json')
  const db = c.get('db')
  await checkOrgRole(db, user, input.owner_org, 'editor')

  const service = new PackageService(db)
  const pkg = await service.create(input, user.id)
  await indexPackage(db, c.get('search'), pkg.id)
  return c.json(pkg, 201)
})

// GET /api/v1/packages/:nameOrId - Get package by name or ID
packagesRouter.get(
  '/:nameOrId',
  zValidator('query', z.object({ state: stateParam })),
  async (c) => {
    const nameOrId = c.req.param('nameOrId')
    const user = c.get('user')
    const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined
    // state=deleted requires authenticated user
    const reqState = c.req.valid('query').state
    const effectiveState = reqState === 'deleted' && user ? 'deleted' : 'active'
    const service = new PackageService(c.get('db'))
    const pkg = await service.getDetailByNameOrId(nameOrId, viewer, effectiveState)
    return c.json(pkg)
  }
)

// PUT /api/v1/packages/:nameOrId - Update package (org editor+)
packagesRouter.put('/:nameOrId', zValidator('json', updatePackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)
  const existing = await service.getByNameOrId(nameOrId)
  if (existing.ownerOrg) await checkOrgRole(db, user, existing.ownerOrg, 'editor')

  const input = c.req.valid('json')
  const pkg = await service.update(nameOrId, input)
  await indexPackage(db, c.get('search'), pkg.id)
  return c.json(pkg)
})

// PATCH /api/v1/packages/:nameOrId - Patch package (org editor+)
packagesRouter.patch('/:nameOrId', zValidator('json', patchPackageSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)
  const existing = await service.getByNameOrId(nameOrId)
  if (existing.ownerOrg) await checkOrgRole(db, user, existing.ownerOrg, 'editor')

  const input = c.req.valid('json')
  const pkg = await service.patch(nameOrId, input)
  await indexPackage(db, c.get('search'), pkg.id)
  return c.json(pkg)
})

// DELETE /api/v1/packages/:nameOrId - Delete package (org editor+)
packagesRouter.delete('/:nameOrId', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)
  const existing = await service.getByNameOrId(nameOrId)
  if (existing.ownerOrg) await checkOrgRole(db, user, existing.ownerOrg, 'editor')

  const pkg = await service.delete(nameOrId)
  await c.get('search').delete(pkg.id)
  return c.json(pkg)
})

// POST /api/v1/packages/:nameOrId/purge - Permanently delete a soft-deleted package (org admin+)
packagesRouter.post('/:nameOrId/purge', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(db)
  const existing = await service.getByNameOrId(nameOrId, 'deleted')
  if (existing.ownerOrg) await checkOrgRole(db, user, existing.ownerOrg, 'admin')

  const pkg = await service.purge(existing.id)
  await c.get('search').delete(pkg.id)
  return c.json(pkg)
})

// PUT /api/v1/packages/:packageId/resources/reorder - Reorder resources (org editor+)
packagesRouter.put(
  '/:packageId/resources/reorder',
  zValidator('json', reorderResourcesSchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new ForbiddenError('Authentication required')

    const db = c.get('db')
    const packageId = c.req.param('packageId')

    const packageService = new PackageService(db)
    const pkg = await packageService.getByNameOrId(packageId)
    if (pkg.ownerOrg) await checkOrgRole(db, user, pkg.ownerOrg, 'editor')

    const { resource_ids } = c.req.valid('json')
    const resourceService = new ResourceService(db)
    const resources = await resourceService.reorder(pkg.id, resource_ids)

    return c.json(resources)
  }
)

// GET /api/v1/packages/:packageId/resources - List resources for package
packagesRouter.get('/:packageId/resources', async (c) => {
  const packageId = c.req.param('packageId')
  const user = c.get('user')
  const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined
  const packageService = new PackageService(c.get('db'))
  // Resolve name or ID to UUID, with private visibility check
  const pkg = await packageService.getByNameOrIdWithAccessCheck(packageId, viewer)

  const resourceService = new ResourceService(c.get('db'))
  const resources = await resourceService.listByPackage(pkg.id)
  return c.json(resources)
})

// POST /api/v1/packages/:packageId/resources - Add resource to package (org editor+)
packagesRouter.post(
  '/:packageId/resources',
  zValidator('json', createResourceBodySchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new ForbiddenError('Authentication required')

    const db = c.get('db')
    const packageId = c.req.param('packageId')
    const input = c.req.valid('json')

    const packageService = new PackageService(db)
    const pkg = await packageService.getByNameOrId(packageId)
    if (pkg.ownerOrg) await checkOrgRole(db, user, pkg.ownerOrg, 'editor')

    const resourceService = new ResourceService(db)
    const resource = await resourceService.create({
      ...input,
      package_id: pkg.id,
    })

    // Enqueue pipeline + index search in parallel (best-effort enqueue)
    // Skip upload resources — pipeline is triggered by upload-complete after file is in storage
    const enqueuePromise =
      input.url && input.url_type !== 'upload'
        ? new PipelineService(db, c.get('queue')).enqueue(resource.id).catch((err) => {
            c.get('logger').error(
              { err, resourceId: resource.id },
              'Best-effort pipeline enqueue failed'
            )
          })
        : Promise.resolve()

    await Promise.all([enqueuePromise, indexPackage(db, c.get('search'), pkg.id)])
    return c.json(resource, 201)
  }
)
