/**
 * KUKAN Groups REST API Routes
 * /api/v1/groups endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { GroupService } from '../services/group-service'
import { createGroupSchema, updateGroupSchema, ForbiddenError } from '@kukan/shared'
import { checkGroupRole } from '../auth/permissions'
import type { AppContext } from '../context'

export const groupsRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/groups - List groups with pagination and search
groupsRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      q: z.string().optional(),
    })
  ),
  async (c) => {
    const params = c.req.valid('query')
    const service = new GroupService(c.get('db'))
    const result = await service.list(params)
    return c.json(result)
  }
)

// POST /api/v1/groups - Create new group (sysadmin only)
groupsRouter.post('/', zValidator('json', createGroupSchema), async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can create groups')

  const { image_url, ...rest } = c.req.valid('json')
  const service = new GroupService(c.get('db'))
  const grp = await service.create({ ...rest, imageUrl: image_url })
  return c.json(grp, 201)
})

// GET /api/v1/groups/:nameOrId - Get group by name or ID
groupsRouter.get('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const service = new GroupService(c.get('db'))
  const grp = await service.getByNameOrId(nameOrId)
  return c.json(grp)
})

// PUT /api/v1/groups/:nameOrId - Update group (sysadmin or group admin)
groupsRouter.put('/:nameOrId', zValidator('json', updateGroupSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new GroupService(db)
  const existing = await service.getByNameOrId(nameOrId)
  await checkGroupRole(db, user, existing.id, 'admin')

  const { image_url, ...rest } = c.req.valid('json')
  const grp = await service.update(nameOrId, { ...rest, imageUrl: image_url })
  return c.json(grp)
})

// DELETE /api/v1/groups/:nameOrId - Delete group (sysadmin or group admin)
groupsRouter.delete('/:nameOrId', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const nameOrId = c.req.param('nameOrId')
  const service = new GroupService(db)
  const existing = await service.getByNameOrId(nameOrId)
  await checkGroupRole(db, user, existing.id, 'admin')

  const result = await service.delete(nameOrId)
  return c.json(result)
})

// POST /api/v1/groups/:nameOrId/purge - Permanently delete a soft-deleted group (sysadmin only)
groupsRouter.post('/:nameOrId/purge', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can purge groups')

  const db = c.get('db')
  const service = new GroupService(db)
  const nameOrId = c.req.param('nameOrId')
  const existing = await service.getByNameOrId(nameOrId, 'deleted')

  const result = await service.purge(existing.id)
  return c.json(result)
})

// POST /api/v1/groups/:nameOrId/restore - Restore a soft-deleted group (sysadmin only)
groupsRouter.post('/:nameOrId/restore', async (c) => {
  const user = c.get('user')
  if (!user?.sysadmin) throw new ForbiddenError('Only sysadmin can restore groups')

  const db = c.get('db')
  const service = new GroupService(db)
  const nameOrId = c.req.param('nameOrId')
  const existing = await service.getByNameOrId(nameOrId, 'deleted')

  const result = await service.restore(existing.id)
  return c.json(result)
})

// ── Member management ──

// GET /api/v1/groups/:nameOrId/members - List members
groupsRouter.get('/:nameOrId/members', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new GroupService(db)
  const grp = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkGroupRole(db, user, grp.id, 'member')

  const members = await service.listMembers(grp.id)
  return c.json({ items: members })
})

// POST /api/v1/groups/:nameOrId/members - Add or update member
groupsRouter.post(
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

    const service = new GroupService(db)
    const grp = await service.getByNameOrId(c.req.param('nameOrId'))
    await checkGroupRole(db, user, grp.id, 'admin')

    const { user_id, role } = c.req.valid('json')
    const result = await service.addMember(grp.id, user_id, role)
    return c.json(result, 201)
  }
)

// DELETE /api/v1/groups/:nameOrId/members/:userId - Remove member
groupsRouter.delete('/:nameOrId/members/:userId', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const service = new GroupService(db)
  const grp = await service.getByNameOrId(c.req.param('nameOrId'))
  await checkGroupRole(db, user, grp.id, 'admin')

  const result = await service.removeMember(grp.id, c.req.param('userId'))
  return c.json(result)
})
