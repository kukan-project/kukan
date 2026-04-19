/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ResourceService } from '../services/resource-service'
import { PipelineService } from '../services/pipeline-service'
import { PackageService } from '../services/package-service'
import {
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  getStorageKey,
  getMimeType,
  detectContentType,
  toCharset,
  isOfficeFormat,
} from '@kukan/shared'
import { TEXT_PREVIEW_LIMIT, DEFAULT_RANGE_CHUNK } from '../config'
import { checkOrgRole, resolveUserOrgIds, buildVisibilityFilters } from '../auth/permissions'
import { indexPackage, indexResourceMetadata } from '../services/search-index'
import { Readable } from 'stream'
import type { Database } from '@kukan/db'
import type { SearchFilters } from '@kukan/search-adapter'
import type { AppContext } from '../context'
import type { Context } from 'hono'

export const resourcesRouter = new Hono<{ Variables: AppContext }>()

/** Convert S3 NoSuchKey errors to 404 NotFoundError */
function throwIfNotFound(err: unknown, resourceId: string): never {
  if (err && typeof err === 'object' && 'name' in err && err.name === 'NoSuchKey') {
    throw new NotFoundError('Resource file', resourceId)
  }
  throw err
}

/** Create pipeline record and enqueue processing job */
async function enqueuePipeline(c: Context<{ Variables: AppContext }>, resourceId: string) {
  const pipelineService = new PipelineService(c.get('db'), c.get('queue'))
  const jobId = await pipelineService.enqueue(resourceId)
  return { pipeline_status: 'queued' as const, job_id: jobId }
}

/** Resolve preview storage key and content type for a resource */
async function resolvePreviewTarget(
  db: Database,
  resource: { id: string; packageId: string; format: string | null }
): Promise<{ storageKey: string; contentType: string } | null> {
  const f = resource.format?.toLowerCase()
  if (f === 'pdf' || isOfficeFormat(resource.format)) {
    return {
      storageKey: getStorageKey(resource.packageId, resource.id),
      contentType: getMimeType(f!)!,
    }
  }
  const pipelineService = new PipelineService(db)
  const status = await pipelineService.getStatus(resource.id)
  if (!status?.previewKey) return null
  return { storageKey: status.previewKey, contentType: detectContentType(status.previewKey) }
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

// GET /api/v1/resources/count - Count active resources with same visibility as package search
resourcesRouter.get('/count', async (c) => {
  const user = c.get('user')
  const myOrg = c.req.query('my_org') === 'true'
  const db = c.get('db')

  // Resolve user's org memberships (for visibility and my_org filters)
  const userOrgIds = await resolveUserOrgIds(db, user)

  // my_org=true with no memberships → 0
  if (myOrg && userOrgIds !== undefined && userOrgIds.length === 0) {
    return c.json({ count: 0 })
  }

  // Build visibility filters (same logic as packages list)
  const filters: SearchFilters = {
    ...buildVisibilityFilters(user, userOrgIds),
    ...(myOrg && userOrgIds?.length && { ownerOrgIds: userOrgIds }),
  }

  // Dashboard (my_org=true) uses PostgreSQL adapter for DB consistency
  const search = myOrg ? c.get('dbSearch') : c.get('search')
  const count = await search.sumResourceCount({ filters })
  return c.json({ count })
})

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
// Hard-limited to TEXT_PREVIEW_LIMIT for preview; use /download for full file.
resourcesRouter.get('/:id/text', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  const [resource, pipelineStatus] = await Promise.all([
    new ResourceService(db).getById(id),
    new PipelineService(db).getStatus(id),
  ])
  const encoding =
    ((pipelineStatus?.metadata as Record<string, unknown> | null)?.encoding as
      | string
      | undefined) ?? 'UNKNOWN'

  const charset = toCharset(encoding)
  const storage = c.get('storage')
  const storageKey = getStorageKey(resource.packageId, resource.id)
  let result
  try {
    result = await storage.downloadRange(storageKey, 0, TEXT_PREVIEW_LIMIT - 1)
  } catch (err) {
    throwIfNotFound(err, id)
  }
  const isTruncated = result.totalSize > TEXT_PREVIEW_LIMIT

  return new Response(Readable.toWeb(result.stream) as ReadableStream, {
    headers: {
      'Content-Type': `text/plain; charset=${charset}`,
      'X-Detected-Encoding': encoding,
      'X-Truncated': String(isTruncated),
      'Cache-Control': 'private, max-age=300',
    },
  })
})

// GET /api/v1/resources/:id/download - Stream file download (public)
// Upload resources: stream from Storage. External URL: 302 redirect.
resourcesRouter.get('/:id/download', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)

  // External URL: redirect to original URL
  if (resource.urlType !== 'upload' && resource.url) {
    return c.redirect(resource.url, 302)
  }

  // Uploaded file: stream from Storage
  const storage = c.get('storage')
  const storageKey = getStorageKey(resource.packageId, resource.id)
  let nodeStream
  try {
    nodeStream = await storage.download(storageKey)
  } catch (err) {
    throwIfNotFound(err, id)
  }

  const filename = resource.url || resource.id
  const encodedFilename = encodeURIComponent(filename)
  const contentType = resource.mimetype || detectContentType(filename)

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    'Cache-Control': 'private, max-age=0',
  }

  if (resource.size) {
    headers['Content-Length'] = String(resource.size)
  }

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, { headers })
})

// GET /api/v1/resources/:id/preview - Server-proxied preview with Range support
// Used by hyparquet (Parquet preview) and local storage (file:// URLs).
resourcesRouter.get('/:id/preview', async (c) => {
  const id = c.req.param('id')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getById(id)
  const storage = c.get('storage')

  const target = await resolvePreviewTarget(c.get('db'), resource)
  if (!target) {
    return c.json({ error: 'Preview not available' }, 404)
  }
  const { storageKey, contentType } = target

  // Handle Range request for Parquet pagination
  const rangeHeader = c.req.header('range')

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (!match) {
      return new Response('Invalid Range', { status: 416 })
    }

    const start = parseInt(match[1], 10)
    const end = match[2] ? parseInt(match[2], 10) : start + DEFAULT_RANGE_CHUNK - 1

    let result
    try {
      result = await storage.downloadRange(storageKey, start, end)
    } catch (err) {
      throwIfNotFound(err, id)
    }

    return new Response(Readable.toWeb(result.stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${result.start}-${result.end}/${result.totalSize}`,
        'Content-Length': String(result.end - result.start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
      },
    })
  }

  // Full response (no Range header)
  let nodeStream
  try {
    nodeStream = await storage.download(storageKey)
  } catch (err) {
    throwIfNotFound(err, id)
  }

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    },
  })
})

// GET /api/v1/resources/:id/pipeline-status - Check pipeline progress (public)
resourcesRouter.get('/:id/pipeline-status', async (c) => {
  const id = c.req.param('id')
  const pipelineService = new PipelineService(c.get('db'))
  const status = await pipelineService.getStatus(id)

  if (!status) {
    return c.json({ id, pipeline_status: null, steps: [] })
  }

  return c.json({
    id,
    pipeline_status: status.status,
    error: status.error,
    updated: status.updated,
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
  await checkResourcePermission(db, user, resourceService, id)

  const input = c.req.valid('json')
  const res = await resourceService.update(id, input)

  // Re-enqueue pipeline + index search in parallel (best-effort enqueue)
  // Skip upload resources — pipeline is triggered by upload-complete after file is in storage
  const enqueuePromise =
    res.url && res.urlType !== 'upload'
      ? enqueuePipeline(c, id).catch((err) => {
          c.get('logger').error({ err, resourceId: id }, 'Best-effort pipeline enqueue failed')
        })
      : Promise.resolve()
  await Promise.all([
    enqueuePromise,
    indexPackage(db, c.get('search'), res.packageId),
    indexResourceMetadata(db, c.get('search'), id),
  ])
  return c.json(res)
})

// DELETE /api/v1/resources/:id - Delete resource (org editor+)
resourcesRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) throw new ForbiddenError('Authentication required')

  const db = c.get('db')
  const search = c.get('search')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

  const res = await resourceService.delete(id)
  await Promise.all([
    indexPackage(db, search, res.packageId),
    search.deleteResource(id),
  ])
  return c.json(res)
})
