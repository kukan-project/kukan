/**
 * KUKAN Organization Routes
 * REST API endpoints for organization management
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { OrganizationService } from '../services/organization-service'
import type { AppContext } from '../context'

const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100).regex(/^[a-z0-9-_]+$/),
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
})

const updateOrganizationSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  state: z.enum(['active', 'deleted']).optional(),
})

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

// POST /api/v1/organizations - Create organization
organizationsRouter.post(
  '/',
  zValidator('json', createOrganizationSchema),
  async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const service = new OrganizationService(db)
    const input = c.req.valid('json')

    const created = await service.create(input, user?.id)
    return c.json(created, 201)
  }
)

// GET /api/v1/organizations/:nameOrId - Get organization by name or ID
organizationsRouter.get('/:nameOrId', async (c) => {
  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')

  const organization = await service.getByNameOrId(nameOrId)
  return c.json(organization)
})

// PUT /api/v1/organizations/:nameOrId - Update organization
organizationsRouter.put(
  '/:nameOrId',
  zValidator('json', updateOrganizationSchema),
  async (c) => {
    const db = c.get('db')
    const service = new OrganizationService(db)
    const nameOrId = c.req.param('nameOrId')
    const input = c.req.valid('json')

    const updated = await service.update(nameOrId, input)
    return c.json(updated)
  }
)

// DELETE /api/v1/organizations/:nameOrId - Delete (soft) organization
organizationsRouter.delete('/:nameOrId', async (c) => {
  const db = c.get('db')
  const service = new OrganizationService(db)
  const nameOrId = c.req.param('nameOrId')

  const result = await service.delete(nameOrId)
  return c.json(result)
})
