/**
 * KUKAN CKAN-Compatible API Routes
 * /api/3/action/* endpoints (CKAN API v3 compatibility)
 */

import { Hono, type Context } from 'hono'
import { PackageService } from '../services/package-service'
import { ResourceService } from '../services/resource-service'
import { OrganizationService } from '../services/organization-service'
import { GroupService } from '../services/group-service'
import { TagService } from '../services/tag-service'
import { resolveUserOrgIds, buildVisibilityFilters } from '../auth/permissions'
import type { AppContext } from '../context'

export const ckanCompatRouter = new Hono<{ Variables: AppContext }>()

/**
 * Convert KUKAN field names to CKAN-compatible snake_case names.
 * - package: created → metadata_created, updated → metadata_modified
 * - resource: updated → metadata_modified, lastModified → last_modified,
 *             packageId → package_id, resourceType → resource_type
 */
function toCkanPackage(pkg: Record<string, unknown>) {
  const { created, updated, creatorUserId, ownerOrg, licenseId, ...rest } = pkg
  return {
    ...rest,
    metadata_created: created,
    metadata_modified: updated,
    creator_user_id: creatorUserId,
    owner_org: ownerOrg,
    license_id: licenseId,
    ...(rest.resources
      ? { resources: (rest.resources as Record<string, unknown>[]).map(toCkanResource) }
      : {}),
  }
}

function toCkanResource(res: Record<string, unknown>) {
  const { updated, lastModified, packageId, resourceType, ...rest } = res
  return {
    ...rest,
    metadata_modified: updated,
    last_modified: lastModified,
    package_id: packageId,
    resource_type: resourceType,
  }
}

/**
 * CKAN-compatible response wrapper
 */
function ckanResponse<T>(result: T, c: Context<{ Variables: AppContext }>) {
  return c.json({
    success: true,
    result,
    help: `${c.req.url}`,
  })
}

/**
 * CKAN-compatible error response
 */
function ckanError(
  message: string,
  c: Context<{ Variables: AppContext }>,
  statusCode: 400 | 404 | 500 = 400
) {
  return c.json(
    {
      success: false,
      error: {
        __type: 'Validation Error',
        message,
      },
      help: `${c.req.url}`,
    },
    statusCode
  )
}

// ============================================================
// Package Actions
// ============================================================

// package_list - List all packages (names only)
ckanCompatRouter.get('/package_list', async (c) => {
  const user = c.get('user')
  const search = c.get('search')

  const searchResult = await search.search({
    q: '',
    offset: 0,
    limit: 1000,
    filters: {
      ...(!user?.sysadmin && { excludePrivate: true }),
    },
  })

  const service = new PackageService(c.get('db'))
  const result = await service.list({
    searchMatchIds: searchResult.items.map((i) => i.id),
    searchTotal: searchResult.total,
  })
  const names = result.items.map((pkg) => pkg.name)
  return ckanResponse(names, c)
})

// package_show - Get package by ID or name
ckanCompatRouter.get('/package_show', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return ckanError('Missing parameter: id', c)
  }

  const user = c.get('user')
  const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined
  const service = new PackageService(c.get('db'))
  try {
    const pkg = await service.getDetailByNameOrId(id, viewer)
    return ckanResponse(toCkanPackage(pkg as unknown as Record<string, unknown>), c)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Package not found'
    return ckanError(message, c, 404)
  }
})

// package_search - Search packages
ckanCompatRouter.get('/package_search', async (c) => {
  const q = c.req.query('q') || ''
  const offset = parseInt(c.req.query('start') || '0', 10)
  const limit = parseInt(c.req.query('rows') || '20', 10)

  const db = c.get('db')
  const user = c.get('user')

  // Resolve user's org memberships for visibility
  const userOrgIds = await resolveUserOrgIds(db, user)

  const searchAdapter = c.get('search')
  const result = await searchAdapter.search({
    q,
    offset,
    limit,
    filters: buildVisibilityFilters(user, userOrgIds),
  })

  return ckanResponse(
    {
      count: result.total,
      results: result.items.map((item) =>
        toCkanPackage(item as unknown as Record<string, unknown>)
      ),
    },
    c
  )
})

// ============================================================
// Resource Actions
// ============================================================

// resource_show - Get resource by ID
ckanCompatRouter.get('/resource_show', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return ckanError('Missing parameter: id', c)
  }

  const service = new ResourceService(c.get('db'))
  try {
    const resource = await service.getById(id)
    if (!resource) {
      return ckanError('Resource not found', c, 404)
    }
    return ckanResponse(toCkanResource(resource as unknown as Record<string, unknown>), c)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Resource not found'
    return ckanError(message, c, 404)
  }
})

// ============================================================
// Organization Actions
// ============================================================

// organization_list - List all organizations (names only)
ckanCompatRouter.get('/organization_list', async (c) => {
  const service = new OrganizationService(c.get('db'))
  const result = await service.list({ offset: 0, limit: 1000 })
  const names = result.items.map((org) => org.name)
  return ckanResponse(names, c)
})

// organization_show - Get organization by ID or name
ckanCompatRouter.get('/organization_show', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return ckanError('Missing parameter: id', c)
  }

  const service = new OrganizationService(c.get('db'))
  try {
    const org = await service.getByNameOrId(id)
    return ckanResponse(org, c)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Organization not found'
    return ckanError(message, c, 404)
  }
})

// ============================================================
// Group Actions
// ============================================================

// group_list - List all groups (names only)
ckanCompatRouter.get('/group_list', async (c) => {
  const service = new GroupService(c.get('db'))
  const result = await service.list({ offset: 0, limit: 1000 })
  const names = result.items.map((grp) => grp.name)
  return ckanResponse(names, c)
})

// group_show - Get group by ID or name
ckanCompatRouter.get('/group_show', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return ckanError('Missing parameter: id', c)
  }

  const service = new GroupService(c.get('db'))
  try {
    const grp = await service.getByNameOrId(id)
    return ckanResponse(grp, c)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Group not found'
    return ckanError(message, c, 404)
  }
})

// ============================================================
// Tag Actions
// ============================================================

// tag_list - List all tags (names only)
ckanCompatRouter.get('/tag_list', async (c) => {
  const service = new TagService(c.get('db'))
  const result = await service.list({ offset: 0, limit: 1000 })
  const names = result.items.map((tag) => tag.name)
  return ckanResponse(names, c)
})

// tag_show - Get tag by ID
ckanCompatRouter.get('/tag_show', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return ckanError('Missing parameter: id', c)
  }

  const service = new TagService(c.get('db'))
  try {
    const tag = await service.getById(id)
    if (!tag) {
      return ckanError('Tag not found', c, 404)
    }
    return ckanResponse(tag, c)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tag not found'
    return ckanError(message, c, 404)
  }
})
