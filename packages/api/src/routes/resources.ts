/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ResourceService } from '../services/resource-service'
import { ResourcePipelineService } from '@kukan/pipeline'
import { PackageService } from '../services/package-service'
import {
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  ForbiddenError,
  ValidationError,
  getStorageKey,
  getMimeType,
  toCharset,
} from '@kukan/shared'
import { checkOrgRole } from '../auth/permissions'
import { Readable } from 'stream'
import type { AppContext } from '../context'
import type { Context } from 'hono'

export const resourcesRouter = new Hono<{ Variables: AppContext }>()

/** Create pipeline record and enqueue processing job */
async function enqueuePipeline(c: Context<{ Variables: AppContext }>, resourceId: string) {
  const pipelineService = new ResourcePipelineService(c.get('db'), c.get('queue'))
  const jobId = await pipelineService.enqueue(resourceId)
  return { pipeline_status: 'queued' as const, job_id: jobId }
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

// GET /api/v1/resources/:id/text - Stream raw bytes with charset header
// Browser decodes via Content-Type charset; no server-side encoding conversion needed.
resourcesRouter.get('/:id/text', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)

  const pipelineService = new ResourcePipelineService(c.get('db'))
  const pipelineStatus = await pipelineService.getStatus(id)
  const encoding =
    ((pipelineStatus?.metadata as Record<string, unknown> | null)?.encoding as
      | string
      | undefined) ?? 'UNKNOWN'

  const charset = toCharset(encoding)
  const storage = c.get('storage')
  const storageKey = getStorageKey(resource.packageId, resource.id)
  const nodeStream = await storage.download(storageKey)

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      'Content-Type': `text/plain; charset=${charset}`,
      'X-Detected-Encoding': encoding,
    },
  })
})

// GET /api/v1/resources/:id/download-url - Get download URL for the resource file
// External URL resources return the original URL; uploaded resources return a presigned Storage URL
resourcesRouter.get('/:id/download-url', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)

  // External URL: return original URL directly
  if (resource.urlType !== 'upload' && resource.url) {
    return c.json({ url: resource.url })
  }

  // Uploaded file: return presigned Storage URL with attachment disposition
  // url contains the original filename for uploaded resources (set by prepareForUpload)
  const storage = c.get('storage')
  const storageKey = getStorageKey(resource.packageId, resource.id)
  const filename = resource.url || resource.id
  const url = await storage.getSignedUrl(storageKey, { filename })
  return c.json({ url })
})

// GET /api/v1/resources/:id/preview-url - Get presigned URL for preview (public)
// CSV/TSV → Parquet preview file, PDF → original file (inline), others → null
resourcesRouter.get('/:id/preview-url', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)
  const f = resource.format?.toLowerCase()
  const storage = c.get('storage')

  // PDF: return original file URL with inline disposition
  if (f === 'pdf') {
    const storageKey = getStorageKey(resource.packageId, resource.id)
    const contentType = getMimeType('pdf')
    const url = await storage.getSignedUrl(storageKey, { inline: true, contentType })
    return c.json({ url })
  }

  // CSV/TSV: return Parquet preview URL
  const pipelineService = new ResourcePipelineService(c.get('db'))
  const status = await pipelineService.getStatus(id)

  if (!status?.previewKey) {
    return c.json({ url: null })
  }

  const url = await storage.getSignedUrl(status.previewKey)
  return c.json({ url })
})

// GET /api/v1/resources/:id/pipeline-status - Check pipeline progress (public)
resourcesRouter.get('/:id/pipeline-status', async (c) => {
  const id = c.req.param('id')
  const pipelineService = new ResourcePipelineService(c.get('db'))
  const status = await pipelineService.getStatus(id)

  if (!status) {
    return c.json({ id, pipeline_status: null, steps: [] })
  }

  return c.json({
    id,
    pipeline_status: status.status,
    error: status.error,
    steps: status.steps.map((s) => ({
      id: s.id,
      step_name: s.stepName,
      status: s.status,
      error: s.error,
      started_at: s.startedAt,
      completed_at: s.completedAt,
    })),
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
  const stream = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0])
  await storage.upload(storageKey, stream, {
    contentType,
    originalFilename: file.name,
  })

  await resourceService.updateAfterUpload(id, { size: file.size })

  return c.json(await enqueuePipeline(c, id), 200)
})

// POST /api/v1/resources/:id/upload-complete - Notify upload done, enqueue pipeline
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

    return c.json(await enqueuePipeline(c, id), 200)
  }
)

// POST /api/v1/resources/:id/run-pipeline - Manually trigger pipeline processing (reprocess)
resourcesRouter.post('/:id/run-pipeline', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

  return c.json(await enqueuePipeline(c, id), 200)
})

// --- CRUD endpoints ---

// PUT /api/v1/resources/:id - Update resource (org editor+)
resourcesRouter.put('/:id', zValidator('json', updateResourceSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  const existing = await checkResourcePermission(db, user, resourceService, id)

  const input = c.req.valid('json')
  const res = await resourceService.update(id, input)

  // Re-enqueue pipeline when external URL changes
  if (input.url && input.url !== existing.url && existing.urlType !== 'upload') {
    await enqueuePipeline(c, id)
  }

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
