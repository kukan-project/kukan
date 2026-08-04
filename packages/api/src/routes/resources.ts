/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '../middleware/validator'
import { z } from 'zod'
import { ResourceService } from '../services/resource-service'
import { PipelineService } from '../services/pipeline-service'
import { PackageService } from '../services/package-service'
import { QueryService } from '../services/query-service'
import {
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  getStorageKey,
  getMimeType,
  detectContentType,
  toCharset,
  isOfficeFormat,
  isImageFormat,
  isPdfFormat,
  isJsonFormat,
  MAX_UPLOAD_SIZE,
} from '@kukan/shared'
import {
  TEXT_PREVIEW_LIMIT,
  JSON_PREVIEW_LIMIT,
  DEFAULT_RANGE_CHUNK,
  QUERY_MAX_SQL_LENGTH,
} from '../config'
import { JsonMinifyStream } from '../streams/json-minify-stream'
import {
  canWritePackage,
  makePackageAuthorize,
  resolveUserOrgIds,
  buildVisibilityFilters,
  type AuthUser,
} from '../auth/permissions'
import { syncPackageMetadata, indexResourceMetadata } from '../services/search-index'
import { Readable } from 'stream'
import type { Database } from '@kukan/db'
import type { SearchFilters } from '@kukan/search-adapter'
import { publicCache } from '../middleware/cache-control'
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
  if (
    isPdfFormat(resource.format) ||
    isOfficeFormat(resource.format) ||
    isImageFormat(resource.format)
  ) {
    return {
      storageKey: getStorageKey(resource.packageId, resource.id),
      contentType: getMimeType(resource.format!)!,
    }
  }
  const pipelineService = new PipelineService(db)
  const status = await pipelineService.getStatus(resource.id)
  if (!status?.previewKey) return null
  return { storageKey: status.previewKey, contentType: detectContentType(status.previewKey) }
}

/** Verify resource ownership and check org editor role (or draft access, ADR-039) */
async function checkResourcePermission(
  db: Database,
  user: AuthUser,
  resourceService: ResourceService,
  resourceId: string
) {
  const existing = await resourceService.getById(resourceId)
  const pkg = await new PackageService(db).getByNameOrId(existing.packageId, ['active', 'draft'])
  await makePackageAuthorize(db, user, 'editor')(pkg)
  return existing
}

// --- Read endpoints ---

// GET /api/v1/resources/count - Count active resources with same visibility as package search
resourcesRouter.get('/count', async (c) => {
  const user = c.get('user')
  const myOrg = c.req.query('my_org') === 'true'
  const db = c.get('db')

  // Visibility counts every membership; my_org narrows to the orgs the viewer
  // may write in, matching the dashboard listing it accompanies (kukan#259)
  const userOrgIds = await resolveUserOrgIds(db, user)
  const manageOrgIds = myOrg ? await resolveUserOrgIds(db, user, 'editor') : undefined

  // No editor membership → 0
  if (manageOrgIds?.length === 0) {
    return c.json({ count: 0 })
  }

  // Build visibility filters (same logic as packages list)
  const filters: SearchFilters = {
    ...buildVisibilityFilters(user, userOrgIds),
    ...(manageOrgIds?.length && { ownerOrgIds: manageOrgIds }),
  }

  // Dashboard (my_org=true) uses PostgreSQL adapter for DB consistency
  const search = myOrg ? c.get('dbSearch') : c.get('search')
  const count = await search.sumResourceCount({ filters })
  return c.json({ count })
})

// GET /api/v1/resources/formats - Get distinct resource formats
resourcesRouter.get('/formats', publicCache(), async (c) => {
  const service = new ResourceService(c.get('db'))
  const formats = await service.getDistinctFormats()
  return c.json(formats)
})

// GET /api/v1/resources/:id - Get resource by ID
resourcesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const user = c.get('user')
  const service = new ResourceService(c.get('db'))
  const res = await service.getByIdWithAccessCheck(id, user)
  return c.json(res)
})

// GET /api/v1/resources/:id/text - Stream raw bytes with charset header
// Browser decodes via Content-Type charset; no server-side encoding conversion needed.
// Hard-limited to TEXT_PREVIEW_LIMIT for preview; use /download for full file.
resourcesRouter.get('/:id/text', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  const user = c.get('user')
  const [resource, pipelineStatus] = await Promise.all([
    new ResourceService(db).getByIdWithAccessCheck(id, user),
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

// GET /api/v1/resources/:id/json - Serve minified JSON/GeoJSON.
// Returns 413 if file exceeds limit (truncated JSON is unparseable).
resourcesRouter.get('/:id/json', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  const user = c.get('user')
  const resource = await new ResourceService(db).getByIdWithAccessCheck(id, user)

  if (!isJsonFormat(resource.format)) {
    return c.json(
      {
        type: 'about:blank',
        title: 'Unsupported Media Type',
        status: 415,
        detail: `Format "${resource.format ?? 'unknown'}" is not a JSON format`,
      },
      415
    )
  }

  const jsonTooLarge = () =>
    c.json(
      {
        type: 'about:blank',
        title: 'Payload Too Large',
        status: 413,
        detail: `JSON file exceeds preview limit (${JSON_PREVIEW_LIMIT} bytes)`,
      },
      413
    )

  // Fast reject by DB size (avoids storage round-trip)
  if (resource.size != null && resource.size > JSON_PREVIEW_LIMIT) {
    return jsonTooLarge()
  }

  const storage = c.get('storage')
  const storageKey = getStorageKey(resource.packageId, resource.id)

  // Single storage call: fetch up to limit bytes and check actual size
  let rangeResult
  try {
    rangeResult = await storage.downloadRange(storageKey, 0, JSON_PREVIEW_LIMIT - 1)
  } catch (err) {
    throwIfNotFound(err, id)
  }
  if (rangeResult.totalSize > JSON_PREVIEW_LIMIT) {
    rangeResult.stream.destroy()
    return jsonTooLarge()
  }

  const contentType = getMimeType(resource.format!) || 'application/json'
  const minified = rangeResult.stream.pipe(new JsonMinifyStream())

  return new Response(Readable.toWeb(minified) as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=300',
    },
  })
})

// GET /api/v1/resources/:id/download - Stream file download (public)
// Upload resources: stream from Storage. External URL: 302 redirect.
resourcesRouter.get('/:id/download', async (c) => {
  const id = c.req.param('id')
  const user = c.get('user')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getByIdWithAccessCheck(id, user)

  // External URL: redirect to original URL (http/https only to prevent open redirect)
  if (resource.urlType !== 'upload' && resource.url) {
    if (!/^https?:\/\//i.test(resource.url)) {
      throw new ValidationError('Resource URL has an unsupported scheme')
    }
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
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  const contentType = resource.mimetype || detectContentType(filename)

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff',
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
  const user = c.get('user')
  const service = new ResourceService(c.get('db'))
  const resource = await service.getByIdWithAccessCheck(id, user)
  const storage = c.get('storage')

  const target = await resolvePreviewTarget(c.get('db'), resource)
  if (!target) {
    return c.json({ error: 'Preview not available' }, 404)
  }
  const { storageKey, contentType } = target

  // Security headers for user-uploaded content served inline:
  // - nosniff: prevent MIME-sniffing (e.g. HTML disguised as .png)
  // - CSP: block script execution in SVG opened directly in browser tab
  //   (<img> tags ignore CSP on sub-resource loads, so preview rendering is unaffected)
  const securityHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    ...(contentType === 'image/svg+xml' && {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    }),
  }

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
        ...securityHeaders,
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
      ...securityHeaders,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    },
  })
})

// GET /api/v1/resources/:id/pipeline-status - Check pipeline progress
resourcesRouter.get('/:id/pipeline-status', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  const user = c.get('user')
  // Same visibility check as download/preview/schema — draft/private resources stay hidden
  const { pkg } = await new ResourceService(db).getByIdWithOwnership(id, user)
  const pipelineService = new PipelineService(db)
  const status = await pipelineService.getStatus(id)

  if (!status) {
    return c.json({ id, pipeline_status: null, steps: [] })
  }

  // Whoever can edit the resource entered the URL, so they get to see why it
  // failed; everyone else gets a generic message rather than error text that
  // could be used to probe hosts (kukan#285). Resolved only when there is an
  // error to show, since the dashboard polls this endpoint.
  const hasError = !!status.error || status.steps.some((s) => s.error)
  const showDetail = hasError && !!user && (await canWritePackage(db, user, pkg, 'editor'))
  const sanitizeError = (err: string | null) =>
    !err ? null : showDetail ? err : 'Processing failed'

  return c.json({
    id,
    pipeline_status: status.status,
    error: sanitizeError(status.error),
    updated: status.updated,
    steps: status.steps.map((s) => ({
      id: s.id,
      step_name: s.stepName,
      status: s.status,
      error: sanitizeError(s.error),
      started_at: s.startedAt,
      completed_at: s.completedAt,
    })),
  })
})

// GET /api/v1/resources/:id/schema - Column schema for a tabular resource (ADR-032)
// Lets clients (and the MCP get_resource_schema tool) discover field names/types
// before downloading the data. `queryable` is false when no schema exists
// (non-tabular format, oversize CSV, or not yet processed).
resourcesRouter.get('/:id/schema', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  const user = c.get('user')
  // Same visibility check as preview/download — the schema reveals the data's shape.
  await new ResourceService(db).getByIdWithAccessCheck(id, user)
  const schema = await new PipelineService(db).getSchema(id)
  return c.json({ id, queryable: schema !== null, schema })
})

// POST /api/v1/resources/:id/query - Run a read-only SQL query over the resource's
// preview Parquet (ADR-032 Part B). The data is exposed as a table named `data`.
// Visibility, "queryable" checks, sandboxing, and limits live in QueryService.
resourcesRouter.post(
  '/:id/query',
  zValidator('json', z.object({ sql: z.string().min(1).max(QUERY_MAX_SQL_LENGTH) })),
  async (c) => {
    const id = c.req.param('id')
    const { sql } = c.req.valid('json')
    const service = new QueryService(c.get('db'), c.get('storage'), c.get('logger'))
    const result = await service.query(id, sql, c.get('user'))
    return c.json({ id, ...result })
  }
)

// --- Upload flow: upload-url → upload → upload-complete ---

// POST /api/v1/resources/:id/upload-url - Get presigned upload URL (new upload or replacement)
resourcesRouter.post('/:id/upload-url', zValidator('json', uploadUrlSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const resourceService = new ResourceService(db)
  const existing = await checkResourcePermission(db, user, resourceService, id)

  const res = await resourceService.prepareForUpload(
    id,
    { filename: input.filename, contentType: input.contentType, format: input.format },
    existing
  )

  const storage = c.get('storage')
  const storageKey = getStorageKey(res.packageId, res.id)
  const uploadUrl = await storage.getSignedUploadUrl(storageKey, input.contentType, undefined, {
    originalFilename: input.filename,
  })

  return c.json({ upload_url: uploadUrl })
})

// POST /api/v1/resources/:id/upload - Server-side upload (multipart, for local storage)
resourcesRouter.post('/:id/upload', bodyLimit({ maxSize: MAX_UPLOAD_SIZE }), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

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
    if (!user) throw new UnauthorizedError()

    const db = c.get('db')
    const id = c.req.param('id')
    const input = c.req.valid('json')

    const resourceService = new ResourceService(db)
    const existing = await checkResourcePermission(db, user, resourceService, id)

    if (existing.urlType !== 'upload') {
      throw new ValidationError('Resource is not an uploaded file')
    }

    // The presigned PUT URL does not bind a content length, so verify the
    // actually-stored object size server-side instead of trusting the client.
    // Reject (and remove) anything over the limit before enqueueing the
    // pipeline, so an oversize object can't drive worker memory exhaustion.
    const storage = c.get('storage')
    const storageKey = getStorageKey(existing.packageId, existing.id)
    const head = await storage.head(storageKey)
    if (!head) {
      throw new ValidationError('Uploaded object not found in storage')
    }
    if (head.size > MAX_UPLOAD_SIZE) {
      await storage.delete(storageKey)
      throw new ValidationError(
        `Uploaded file exceeds the maximum size of ${MAX_UPLOAD_SIZE} bytes`
      )
    }

    // Record the actual stored size (not the client-reported value).
    // updateAfterUpload ignores an undefined hash, so no need to guard it here.
    await resourceService.updateAfterUpload(id, { size: head.size, hash: input.hash })

    return c.json(await enqueuePipeline(c, id), 200)
  }
)

// POST /api/v1/resources/:id/run-pipeline - Manually trigger pipeline processing (reprocess)
resourcesRouter.post('/:id/run-pipeline', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

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
  if (!user) throw new UnauthorizedError()

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
    syncPackageMetadata(db, c.var, res.packageId),
    indexResourceMetadata(db, c.get('search'), id),
  ])
  return c.json(res)
})

// DELETE /api/v1/resources/:id - Delete resource (org editor+)
resourcesRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const search = c.get('search')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

  const res = await resourceService.delete(id)
  await Promise.all([
    syncPackageMetadata(db, c.var, res.packageId),
    search.deleteResource(id),
    search.deleteContent(id),
  ])
  return c.json(res)
})
