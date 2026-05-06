/**
 * KUKAN Organization Routes
 * REST API endpoints for organization management
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createOrganizationSchema, updateOrganizationSchema, ForbiddenError } from '@kukan/shared'
import { OrganizationService } from '../services/organization-service'
import { checkOrgRole } from '../auth/permissions'
import type { AppContext } from '../context'

export const organizationsRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/organizations - List all organizations
organizationsRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
      q: z.string().optional(),
    })
  ),
  async (c) => {
    const db = c.get('db')
    const service = new OrganizationService(db)
    const params = c.req.valid('query')

    const result = await service.list(params)
    return c.json(result)
  }
)

// POST /api/v1/organizations - Create organization (sysadmin only)
organizationsRouter.post('/', zValidator('json', createOrganizationSchema), async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can create organizations')

  const service = new OrganizationService(db)
  const { image_url, ...rest } = c.req.valid('json')

  const created = await service.create({ ...rest, imageUrl: image_url })
  return c.json(created, 201)
})

// GET /api/v1/organizations/:nameOrId - Get organization by name or ID
organizationsRouter.get('/:nameOrId', async (c) => {
  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')

  const organization = await service.getByNameOrId(nameOrId)
  return c.json(organization)
})

// PUT /api/v1/organizations/:nameOrId - Update organization (sysadmin or org admin)
organizationsRouter.put('/:nameOrId', zValidator('json', updateOrganizationSchema), async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const org = await service.getByNameOrId(nameOrId)
  await checkOrgRole(db, user, org.id, 'admin')

  const { image_url, ...rest } = c.req.valid('json')
  const updated = await service.update(nameOrId, { ...rest, imageUrl: image_url })
  return c.json(updated)
})

// DELETE /api/v1/organizations/:nameOrId - Delete (soft) organization (sysadmin or org admin)
organizationsRouter.delete('/:nameOrId', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const org = await service.getByNameOrId(nameOrId)
  await checkOrgRole(db, user, org.id, 'admin')

  const result = await service.delete(nameOrId)
  return c.json(result)
})

// POST /api/v1/organizations/:nameOrId/purge - Permanently delete a soft-deleted organization (sysadmin only)
organizationsRouter.post('/:nameOrId/purge', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can purge organizations')

  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')
  const existing = await service.getByNameOrId(nameOrId, 'deleted')

  await service.purge(existing.id)
  return c.json({ success: true })
})

// POST /api/v1/organizations/:nameOrId/restore - Restore a soft-deleted organization (sysadmin only)
organizationsRouter.post('/:nameOrId/restore', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can restore organizations')

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
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new OrganizationService(db)
  const org = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkOrgRole(db, user, org.id, 'member')

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
    if (!user) throw new ForbiddenError('Authentication required')

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
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new OrganizationService(db)
  const org = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkOrgRole(db, user, org.id, 'admin')

  const result = await service.removeMember(org.id, c.req.param('userId'))
  return c.json(result)
})
