/**
 * KUKAN Packages REST API Routes
 * /api/v1/packages endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { PackageService } from '../services/package-service'
import { createPackageSchema, updatePackageSchema, patchPackageSchema } from '@kukan/shared'
import type { AppContext } from '../context'

export const packagesRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/packages - List packages with pagination and search
packagesRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      offset: z.coerce.number().min(0).default(0),
      limit: z.coerce.number().min(1).max(100).default(20),
      q: z.string().optional(),
      owner_org: z.string().uuid().optional(),
      private: z
        .string()
        .optional()
        .transform((val) => (val === 'true' ? true : val === 'false' ? false : undefined)),
    })
  ),
  async (c) => {
    const params = c.req.valid('query')
    const service = new PackageService(c.get('db'))
    const result = await service.list(params)
    return c.json(result)
  }
)

// POST /api/v1/packages - Create new package
packagesRouter.post('/', zValidator('json', createPackageSchema), async (c) => {
  const input = c.req.valid('json')
  const service = new PackageService(c.get('db'))
  const user = c.get('user')
  const pkg = await service.create(input, user?.id)
  return c.json(pkg, 201)
})

// GET /api/v1/packages/:nameOrId - Get package by name or ID
packagesRouter.get('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(c.get('db'))
  const pkg = await service.getByNameOrId(nameOrId)
  return c.json(pkg)
})

// PUT /api/v1/packages/:nameOrId - Update package (full replace)
packagesRouter.put('/:nameOrId', zValidator('json', updatePackageSchema), async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const input = c.req.valid('json')
  const service = new PackageService(c.get('db'))
  const pkg = await service.update(nameOrId, input)
  return c.json(pkg)
})

// PATCH /api/v1/packages/:nameOrId - Patch package (partial update)
packagesRouter.patch('/:nameOrId', zValidator('json', patchPackageSchema), async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const input = c.req.valid('json')
  const service = new PackageService(c.get('db'))
  const pkg = await service.patch(nameOrId, input)
  return c.json(pkg)
})

// DELETE /api/v1/packages/:nameOrId - Delete package (soft delete)
packagesRouter.delete('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const service = new PackageService(c.get('db'))
  const pkg = await service.delete(nameOrId)
  return c.json(pkg)
})
