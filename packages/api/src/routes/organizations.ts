/**
 * KUKAN Organization Routes
 * REST API endpoints for organization management
 */

import { Hono } from 'hono'
import { zValidator } from '../middleware/validator'
import { z } from 'zod'
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  ForbiddenError,
  UnauthorizedError,
} from '@kukan/shared'
import { OrganizationService } from '../services/organization-service'
import { checkOrgRole, ROSTER_ROLE } from '../auth/permissions'
import { publicCache } from '../middleware/cache-control'
import type { AppContext } from '../context'

export const organizationsRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/organizations - List all organizations
organizationsRouter.get(
  '/',
  publicCache(),
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
      q: z.string().optional(),
      state: z.enum(['active', 'deleted']).optional(),
      orderBy: z.enum(['name', 'datasetCount']).default('name'),
    })
  ),
  async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const service = new OrganizationService(db)
    const params = c.req.valid('query')

    // Listing soft-deleted orgs (the trash view) is sysadmin-only and uncached.
    // No viewer is passed: the trash view offers no member action to count for.
    if (params.state === 'deleted') {
      if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can list deleted organizations')
      return c.json(await service.list(params))
    }

    // publicCache() middleware caches this for anonymous callers only; signed-in
    // dashboard users fall through to `private, no-cache` for immediate freshness.
    // The viewer also decides which rows carry a member count.
    return c.json(await service.list({ ...params, state: 'active' }, user))
  }
)

// POST /api/v1/organizations - Create organization (sysadmin only)
organizationsRouter.post('/', zValidator('json', createOrganizationSchema), async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can create organizations')

  const service = new OrganizationService(db)
  const input = c.req.valid('json')

  const created = await service.create(input)
  return c.json(created, 201)
})

// GET /api/v1/organizations/:nameOrId - Get organization by name or ID
organizationsRouter.get(
  '/:nameOrId',
  publicCache(),
  zValidator('query', z.object({ state: z.enum(['active', 'deleted']).optional() })),
  async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const nameOrId = c.req.param('nameOrId')
    const service = new OrganizationService(db)

    // Soft-deleted orgs are sysadmin-only and must not be cached.
    if (c.req.valid('query').state === 'deleted') {
      if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can view deleted organizations')
      return c.json(await service.getByNameOrId(nameOrId, 'deleted'))
    }

    const organization = await service.getByNameOrId(nameOrId)
    const datasetCount = await service.countActivePackages(organization.id)
    // publicCache() caches for anonymous only; authenticated dashboard reads stay
    // fresh so the delete gate reflects the current active dataset count.
    return c.json({ ...organization, datasetCount })
  }
)

// PUT /api/v1/organizations/:nameOrId - Update organization (sysadmin or org admin)
organizationsRouter.put('/:nameOrId', zValidator('json', updateOrganizationSchema), async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const org = await service.getByNameOrId(nameOrId)
  await checkOrgRole(db, user, org.id, 'admin')

  const input = c.req.valid('json')
  const updated = await service.update(nameOrId, input)
  return c.json(updated)
})

// DELETE /api/v1/organizations/:nameOrId - Delete (soft) organization (sysadmin or org admin)
organizationsRouter.delete('/:nameOrId', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const org = await service.getByNameOrId(nameOrId)
  await checkOrgRole(db, user, org.id, 'admin')

  const result = await service.delete(nameOrId)
  return c.json(result)
})

// POST /api/v1/organizations/:nameOrId/purge - Permanently delete a soft-deleted organization (sysadmin only)
// Enqueues an async purge job; the org stays soft-deleted until the worker erases it.
organizationsRouter.post('/:nameOrId/purge', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can purge organizations')

  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const existing = await service.getByNameOrId(nameOrId, 'deleted')

  await service.requestPurge(existing.id, { queue: c.get('queue') })
  return c.json({ success: true })
})

// POST /api/v1/organizations/:nameOrId/restore - Restore a soft-deleted organization (sysadmin only)
organizationsRouter.post('/:nameOrId/restore', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can restore organizations')

  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const existing = await service.getByNameOrId(nameOrId, 'deleted')

  const result = await service.restore(existing.id)
  return c.json(result)
})

// ── Member management ──

// GET /api/v1/organizations/:nameOrId/members - List members
organizationsRouter.get('/:nameOrId/members', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const service = new OrganizationService(db)
  const org = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkOrgRole(db, user, org.id, ROSTER_ROLE)

  const members = await service.listMembers(org.id)
  return c.json({ items: members })
})

// POST /api/v1/organizations/:nameOrId/members - Add or update member
organizationsRouter.post(
  '/:nameOrId/members',
  zValidator(
    'json',
    z.object({
      user_id: z.string().min(1),
      role: z.enum(['admin', 'editor', 'member']).default('member'),
    })
  ),
  async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()

    const service = new OrganizationService(db)
    const org = await service.getByNameOrId(c.req.param('nameOrId'))
    await checkOrgRole(db, user, org.id, 'admin')

    const { user_id, role } = c.req.valid('json')
    const result = await service.addMember(org.id, user_id, role)
    return c.json(result, 201)
  }
)

// DELETE /api/v1/organizations/:nameOrId/members/:userId - Remove member
organizationsRouter.delete('/:nameOrId/members/:userId', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const service = new OrganizationService(db)
  const org = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkOrgRole(db, user, org.id, 'admin')

  const result = await service.removeMember(org.id, c.req.param('userId'))
  return c.json(result)
})
