/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ResourceService } from '../services/resource-service'
import { createResourceSchema, updateResourceSchema } from '@kukan/shared'
import type { AppContext } from '../context'

export const resourcesRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/resources/:id - Get resource by ID
resourcesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const res = await service.getById(id)
  return c.json(res)
})

// PUT /api/v1/resources/:id - Update resource
resourcesRouter.put('/:id', zValidator('json', updateResourceSchema), async (c) => {
  const id = c.req.param('id')
  const input = c.req.valid('json')
  const service = new ResourceService(c.get('db'))
  const res = await service.update(id, input)
  return c.json(res)
})

// DELETE /api/v1/resources/:id - Delete resource (soft delete)
resourcesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const res = await service.delete(id)
  return c.json(res)
})
