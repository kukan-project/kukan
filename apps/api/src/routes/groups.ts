/**
 * KUKAN Groups REST API Routes
 * /api/v1/groups endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { GroupService } from '../services/group-service'
import { createGroupSchema, updateGroupSchema } from '@kukan/shared'
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

// POST /api/v1/groups - Create new group
groupsRouter.post('/', zValidator('json', createGroupSchema), async (c) => {
  const input = c.req.valid('json')
  const service = new GroupService(c.get('db'))
  const grp = await service.create(input)
  return c.json(grp, 201)
})

// GET /api/v1/groups/:nameOrId - Get group by name or ID
groupsRouter.get('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const service = new GroupService(c.get('db'))
  const grp = await service.getByNameOrId(nameOrId)
  return c.json(grp)
})

// PUT /api/v1/groups/:nameOrId - Update group
groupsRouter.put('/:nameOrId', zValidator('json', updateGroupSchema), async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const input = c.req.valid('json')
  const service = new GroupService(c.get('db'))
  const grp = await service.update(nameOrId, input)
  return c.json(grp)
})

// DELETE /api/v1/groups/:nameOrId - Delete group (soft delete)
groupsRouter.delete('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const service = new GroupService(c.get('db'))
  const result = await service.delete(nameOrId)
  return c.json(result)
})
