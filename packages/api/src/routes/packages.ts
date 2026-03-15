/**
 * KUKAN Packages REST API Routes
 * /api/v1/packages endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { PackageService } from '../services/package-service'
import { ResourceService } from '../services/resource-service'
import {
  createPackageSchema,
  updatePackageSchema,
  patchPackageSchema,
  createResourceSchema,
  ForbiddenError,
} from '@kukan/shared'
import { checkOrgRole } from '../auth/permissions'
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
      owner_org: z.string().optional(),
      group: z.string().optional(),
      creator_user_id: z.string().optional(),
      my_org: z
        .string()
        .optional()
        .transform((val) => val === 'true'),
      private: z
        .string()
        .optional()
        .transform((val) => (val === 'true' ? true : val === 'false' ? false : undefined)),
    })
  ),
  async (c) => {
    const { my_org, ...rest } = c.req.valid('query')
    const service = new PackageService(c.get('db'))
    const user = c.get('user')

    // my_org=true: filter by authenticated user's organization memberships
    const member_user_id = my_org && user && !user.sysadmin ? user.id : undefined
    const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined

    const result = await service.list({ ...rest, member_user_id, viewer })
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
  return c.json(pkg, 201)
})

// GET /api/v1/packages/:nameOrId - Get package by name or ID
packagesRouter.get('/:nameOrId', async (c) => {
  const nameOrId = c.req.param('nameOrId')
  const user = c.get('user')
  const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined
  const service = new PackageService(c.get('db'))
  const pkg = await service.getDetailByNameOrId(nameOrId, viewer)
  return c.json(pkg)
})

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
  return c.json(pkg)
})

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
  zValidator('json', createResourceSchema.omit({ package_id: true })),
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
    return c.json(resource, 201)
  }
)
