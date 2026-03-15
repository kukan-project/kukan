/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ResourceService } from '../services/resource-service'
import { PreviewService } from '../services/preview-service'
import { PackageService } from '../services/package-service'
import { updateResourceSchema, ForbiddenError } from '@kukan/shared'
import { checkOrgRole } from '../auth/permissions'
import type { AppContext } from '../context'

export const resourcesRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/resources/formats - Get distinct resource formats
resourcesRouter.get('/formats', async (c) => {
  const service = new ResourceService(c.get('db'))
  const formats = await service.getDistinctFormats()
  return c.json(formats)
})

// GET /api/v1/resources/:id - Get resource by ID
resourcesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const res = await service.getById(id)
  return c.json(res)
})

// GET /api/v1/resources/:id/preview - Get CSV preview data
resourcesRouter.get('/:id/preview', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)

  const previewService = new PreviewService(c.get('storage'))
  const preview = await previewService.getPreview({
    format: resource.format,
    mimetype: resource.mimetype,
    storageKey: resource.storageKey,
    url: resource.url,
  })
  return c.json(preview)
})

// PUT /api/v1/resources/:id - Update resource (org editor+)
resourcesRouter.put('/:id', zValidator('json', updateResourceSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  const existing = await resourceService.getById(id)
  const pkg = await new PackageService(db).getByNameOrId(existing.packageId)
  if (pkg.ownerOrg) await checkOrgRole(db, user, pkg.ownerOrg, 'editor')

  const input = c.req.valid('json')
  const res = await resourceService.update(id, input)
  return c.json(res)
})

// DELETE /api/v1/resources/:id - Delete resource (org editor+)
resourcesRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  const existing = await resourceService.getById(id)
  const pkg = await new PackageService(db).getByNameOrId(existing.packageId)
  if (pkg.ownerOrg) await checkOrgRole(db, user, pkg.ownerOrg, 'editor')

  const res = await resourceService.delete(id)
  return c.json(res)
})
