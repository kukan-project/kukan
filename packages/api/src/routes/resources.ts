/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ResourceService, getStorageKey } from '../services/resource-service'
import { PreviewService } from '../services/preview-service'
import { PackageService } from '../services/package-service'
import {
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  ForbiddenError,
  ValidationError,
} from '@kukan/shared'
import { checkOrgRole } from '../auth/permissions'
import type { AppContext } from '../context'
import type { Context } from 'hono'

export const resourcesRouter = new Hono<{ Variables: AppContext }>()

/** Mark resource as queued and enqueue an ingest job */
async function enqueueIngest(
  c: Context<{ Variables: AppContext }>,
  resourceService: ResourceService,
  resourceId: string
) {
  await resourceService.updateIngestStatus(resourceId, 'queued')
  const queue = c.get('queue')
  const jobId = await queue.enqueue('ingest', { resourceId })
  return { ingest_status: 'queued' as const, job_id: jobId }
}

/** Verify resource ownership and check org editor role */
async function checkResourcePermission(
  db: Parameters<typeof checkOrgRole>[0],
  user: Parameters<typeof checkOrgRole>[1],
  resourceService: ResourceService,
  resourceId: string
) {
  const existing = await resourceService.getById(resourceId)
  const pkg = await new PackageService(db).getByNameOrId(existing.packageId)
  if (pkg.ownerOrg) await checkOrgRole(db, user, pkg.ownerOrg, 'editor')
  return existing
}

// --- Read endpoints ---

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
  const storageKey =
    resource.urlType === 'upload' ? getStorageKey(resource.packageId, resource.id) : undefined
  const preview = await previewService.getPreview({
    format: resource.format,
    mimetype: resource.mimetype,
    storageKey,
    url: resource.url,
  })
  return c.json(preview)
})

// GET /api/v1/resources/:id/ingest-status - Check ingest progress (public)
resourcesRouter.get('/:id/ingest-status', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const res = await service.getById(id)

  return c.json({
    id: res.id,
    ingest_status: res.ingestStatus,
    ingest_error: res.ingestError,
  })
})

// --- Upload flow: upload-url → upload → upload-complete ---

// POST /api/v1/resources/:id/upload-url - Get presigned upload URL (new upload or replacement)
resourcesRouter.post('/:id/upload-url', zValidator('json', uploadUrlSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const resourceService = new ResourceService(db)
  const existing = await checkResourcePermission(db, user, resourceService, id)

  const res = await resourceService.prepareForUpload(
    id,
    { filename: input.filename, contentType: input.content_type, format: input.format },
    existing
  )

  const storage = c.get('storage')
  const storageKey = getStorageKey(res.packageId, res.id)
  const uploadUrl = await storage.getSignedUploadUrl(storageKey, input.content_type, undefined, {
    originalFilename: input.filename,
  })

  return c.json({ upload_url: uploadUrl })
})

// POST /api/v1/resources/:id/upload - Server-side upload (multipart, for local storage)
resourcesRouter.post('/:id/upload', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')

  const resourceService = new ResourceService(db)
  const existing = await checkResourcePermission(db, user, resourceService, id)

  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    throw new ValidationError('Missing "file" field in multipart form data')
  }

  const contentType = file.type || 'application/octet-stream'
  const res = await resourceService.prepareForUpload(
    id,
    { filename: file.name, contentType },
    existing
  )

  const storage = c.get('storage')
  const storageKey = getStorageKey(res.packageId, res.id)
  const buffer = Buffer.from(await file.arrayBuffer())
  await storage.upload(storageKey, buffer, {
    contentType,
    originalFilename: file.name,
  })

  await resourceService.updateAfterUpload(id, { size: buffer.length })

  return c.json(await enqueueIngest(c, resourceService, id), 200)
})

// POST /api/v1/resources/:id/upload-complete - Notify upload done, enqueue ingest
resourcesRouter.post(
  '/:id/upload-complete',
  zValidator('json', uploadCompleteSchema),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new ForbiddenError('Authentication required')

    const db = c.get('db')
    const id = c.req.param('id')
    const input = c.req.valid('json')

    const resourceService = new ResourceService(db)
    const existing = await checkResourcePermission(db, user, resourceService, id)

    if (existing.urlType !== 'upload') {
      throw new ValidationError('Resource is not an uploaded file')
    }

    if (input.size || input.hash) {
      await resourceService.updateAfterUpload(id, input)
    }

    return c.json(await enqueueIngest(c, resourceService, id), 200)
  }
)

// --- CRUD endpoints ---

// PUT /api/v1/resources/:id - Update resource (org editor+)
resourcesRouter.put('/:id', zValidator('json', updateResourceSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

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
  await checkResourcePermission(db, user, resourceService, id)

  const res = await resourceService.delete(id)
  return c.json(res)
})
