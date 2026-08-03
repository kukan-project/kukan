/**
 * KUKAN Resources REST API Routes
 * /api/v1/resources endpoints
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { lakeConfigFromEnv } from '@kukan/lake'
import { ResourceService, omitStoragePointers } from '../services/resource-service'
import { ResourceVersionService } from '../services/resource-version-service'
import { VersionDiffService } from '../services/version-diff-service'
import { PipelineService } from '../services/pipeline-service'
import { cancelResourceRun } from '../services/pipeline-claim'
import { PackageService } from '../services/package-service'
import { QueryService } from '../services/query-service'
import {
  updateResourceSchema,
  uploadUrlSchema,
  uploadCompleteSchema,
  revertResourceSchema,
  runPipelineSchema,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  PURGE_VERSION_JOB_TYPE,
  getMimeType,
  detectContentType,
  versionedFilename,
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

/** Parse a `:v` path param into a positive version number (rejects junk). */
function parseVersionParam(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('Invalid version number')
  }
  return n
}

/**
 * Response headers for an attachment download. The filename is sent twice:
 * an ASCII-only form for old clients, and RFC 5987 UTF-8 for everyone else.
 */
function downloadHeaders(
  filename: string,
  contentType: string,
  size: number | null
): Record<string, string> {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  }
  if (size) headers['Content-Length'] = String(size)
  return headers
}

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

/**
 * The object holding the resource's content, or a 404 when none is stored
 * (ADR-043): a link-type resource never fetched, an upload never completed, or
 * content a purge removed with no version to fall back to.
 */
function liveKey(res: { id: string; storageKey: string | null }): string {
  if (!res.storageKey) throw new NotFoundError('Resource file', res.id)
  return res.storageKey
}

/** Resolve preview storage key and content type for a resource */
async function resolvePreviewTarget(
  db: Database,
  resource: { id: string; packageId: string; format: string | null; storageKey: string | null }
): Promise<{ storageKey: string; contentType: string } | null> {
  if (
    isPdfFormat(resource.format) ||
    isOfficeFormat(resource.format) ||
    isImageFormat(resource.format)
  ) {
    return {
      storageKey: liveKey(resource),
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
  return c.json(omitStoragePointers(res))
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
      string | undefined) ?? 'UNKNOWN'

  const charset = toCharset(encoding)
  const storage = c.get('storage')
  let result
  try {
    result = await storage.downloadRange(liveKey(resource), 0, TEXT_PREVIEW_LIMIT - 1)
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

  // Single storage call: fetch up to limit bytes and check actual size
  let rangeResult
  try {
    rangeResult = await storage.downloadRange(liveKey(resource), 0, JSON_PREVIEW_LIMIT - 1)
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
  let nodeStream
  try {
    nodeStream = await storage.download(liveKey(resource))
  } catch (err) {
    throwIfNotFound(err, id)
  }

  const filename = resource.url || resource.id
  const headers = downloadHeaders(
    filename,
    resource.mimetype || detectContentType(filename),
    resource.size
  )

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
  await new ResourceService(db).getByIdWithAccessCheck(id, user)
  const pipelineService = new PipelineService(db)
  // Where a revert would put the content, and the generation it would be acting
  // on. Served with the status because the revert control lives on it and
  // echoes both back (ADR-044 §4): the destination is what makes a resend land
  // in the same place, the generation is what refuses a request that was
  // overtaken by newer content.
  const [status, revert] = await Promise.all([
    pipelineService.getStatus(id),
    new ResourceVersionService(db).revertContext(id),
  ])
  const revertFields = { revert_target: revert.revertTarget, live_revision: revert.liveRevision }

  if (!status) {
    return c.json({ id, pipeline_status: null, steps: [], ...revertFields })
  }

  // Only expose raw error details to sysadmin; others get a generic message
  const sanitizeError = (err: string | null) =>
    !err ? null : user?.sysadmin ? err : 'Processing failed'

  return c.json({
    id,
    pipeline_status: status.status,
    error: sanitizeError(status.error),
    updated: status.updated,
    ...revertFields,
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

// --- Resource versions (ADR-043, layer 1) ---

// GET /api/v1/resources/:id/versions - List canonical file versions (newest first).
// Same visibility check as download/preview. Purged versions appear as tombstones.
resourcesRouter.get('/:id/versions', async (c) => {
  const id = c.req.param('id')
  const db = c.get('db')
  await new ResourceService(db).getByIdWithAccessCheck(id, c.get('user'))
  const versions = await new ResourceVersionService(db).listByResource(id)
  return c.json({ id, versions })
})

// GET /api/v1/resources/:id/versions/:v - Single version metadata.
resourcesRouter.get('/:id/versions/:v', async (c) => {
  const id = c.req.param('id')
  const version = parseVersionParam(c.req.param('v'))
  const db = c.get('db')
  await new ResourceService(db).getByIdWithAccessCheck(id, c.get('user'))
  const view = await new ResourceVersionService(db).getVersion(id, version)
  return c.json(view)
})

// GET /api/v1/resources/:id/versions/:v/diff - Row-level diff against another
// version (ADR-043 layer 2). `from` defaults to the preceding version. The SQL
// is composed server-side from version numbers; the ADR-032 query sandbox is a
// separate path and is not involved.
resourcesRouter.get('/:id/versions/:v/diff', async (c) => {
  const id = c.req.param('id')
  const version = parseVersionParam(c.req.param('v'))
  const fromRaw = c.req.query('from')
  const from = fromRaw === undefined ? undefined : parseVersionParam(fromRaw)
  const db = c.get('db')
  // Editor on the owning package, not merely visibility: ii-a's diff lives in
  // the dashboard (spec §7.1), and it is the one version route that scans both
  // snapshots in full. Public diffs are Phase iii.
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()
  await checkResourcePermission(db, user, new ResourceService(db), id)
  const service = new VersionDiffService(db, lakeConfigFromEnv(c.get('env')))
  const view = await service.diff(id, version, from)
  // A computed diff is immutable — both snapshots are written once and never
  // change — and it is the most expensive GET here, so a re-expand in the UI
  // must not re-run it. An unavailable answer is not cached that way: a version
  // reported as not-ingested becomes ingestable the moment the backfill runs.
  if (view.available) c.header('Cache-Control', 'private, max-age=86400, immutable')
  return c.json(view)
})

// GET /api/v1/resources/:id/versions/:v/download - Stream a specific version's bytes.
resourcesRouter.get('/:id/versions/:v/download', async (c) => {
  const id = c.req.param('id')
  const version = parseVersionParam(c.req.param('v'))
  const db = c.get('db')
  const resource = await new ResourceService(db).getByIdWithAccessCheck(id, c.get('user'))
  const { storageKey, size } = await new ResourceVersionService(db).getDownloadTarget(id, version)

  const storage = c.get('storage')
  let nodeStream
  try {
    nodeStream = await storage.download(storageKey)
  } catch (err) {
    throwIfNotFound(err, id)
  }

  const original = resource.url || resource.id
  const headers = downloadHeaders(
    versionedFilename(original, version),
    resource.mimetype || detectContentType(original),
    size
  )

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, { headers })
})

// POST /api/v1/resources/:id/versions/:v/purge - Legal deletion of one version.
// Sysadmin only; a reason is required and recorded. Claims the version (async),
// then a worker job destroys the content (rolling back the live version if needed).
resourcesRouter.post(
  '/:id/versions/:v/purge',
  zValidator('json', z.object({ reason: z.string().trim().min(1) })),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()
    if (!user.sysadmin) throw new ForbiddenError('Only sysadmin can purge resource versions')

    const id = c.req.param('id')
    const version = parseVersionParam(c.req.param('v'))
    const { reason } = c.req.valid('json')
    const db = c.get('db')

    // 404 if the resource doesn't exist.
    await new ResourceService(db).getById(id)

    const { claimed, view } = await new ResourceVersionService(db).claimPurge(
      id,
      version,
      user.id,
      reason
    )
    // Only enqueue when we actually claimed it (idempotent on repeat calls).
    if (claimed) {
      await c.get('queue').enqueue(PURGE_VERSION_JOB_TYPE, { resourceId: id, version })
    }
    return c.json(view, 202)
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

  const pendingKey = await resourceService.prepareForUpload(
    id,
    { filename: input.filename, contentType: input.contentType, format: input.format },
    existing
  )

  const storage = c.get('storage')
  const uploadUrl = await storage.getSignedUploadUrl(pendingKey, input.contentType, undefined, {
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
  const pendingKey = await resourceService.prepareForUpload(
    id,
    { filename: file.name, contentType },
    existing
  )

  const storage = c.get('storage')
  const stream = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0])
  await storage.upload(pendingKey, stream, {
    contentType,
    originalFilename: file.name,
  })

  // Promote the key we wrote to, not whatever is pending now: a concurrent
  // request may have replaced it, and promoting that one would point the
  // resource at an object nobody has uploaded yet.
  if (!(await resourceService.promoteUpload(id, pendingKey, { size: file.size }))) {
    throw new ValidationError('A newer upload replaced this one before it completed')
  }

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

    const resourceService = new ResourceService(db)
    const existing = await checkResourcePermission(db, user, resourceService, id)

    // The presigned PUT URL does not bind a content length, so verify the
    // actually-stored object size server-side instead of trusting the client.
    // Reject (and remove) anything over the limit before enqueueing the
    // pipeline, so an oversize object can't drive worker memory exhaustion.
    // The pending key is checked, never the live one: rejecting must not touch
    // the content the resource is still serving.
    // The precondition is that an upload is pending, which this states exactly.
    // `url_type` no longer says so: it describes the content being served, and
    // only becomes 'upload' when this call promotes the new object.
    const storage = c.get('storage')
    const pendingKey = existing.pendingStorageKey
    if (!pendingKey) {
      throw new ValidationError('No upload is pending for this resource')
    }
    const head = await storage.head(pendingKey)
    if (!head) {
      throw new ValidationError('Uploaded object not found in storage')
    }
    if (head.size > MAX_UPLOAD_SIZE) {
      await storage.delete(pendingKey)
      throw new ValidationError(
        `Uploaded file exceeds the maximum size of ${MAX_UPLOAD_SIZE} bytes`
      )
    }

    // Size comes from storage, not the client, and the hash is left for the
    // worker to measure (ADR-043): version create records the hash against the
    // bytes it copies, so a caller-supplied value would decide what a version
    // claims to hold.
    // Bound to the key that was headed above, so a `prepareForUpload` that ran
    // in between cannot have this call promote its not-yet-uploaded key — with
    // the size measured from a different object.
    if (!(await resourceService.promoteUpload(id, pendingKey, { size: head.size }))) {
      throw new ValidationError('No upload is pending for this resource')
    }

    return c.json(await enqueuePipeline(c, id), 200)
  }
)

// POST /api/v1/resources/:id/run-pipeline - Manually trigger pipeline processing (reprocess)
//
// `rebuildOnly` regenerates the derivatives from the object the resource already
// holds, fetching nothing (ADR-044 §4). Its own action rather than something a
// client has to remember: repairing a rebuild that failed after a revert is
// otherwise only reachable by resending that revert, and a request nobody kept
// is a repair nobody can make — leaving the plain reprocess, which re-reads an
// external URL and undoes the revert.
resourcesRouter.post(
  '/:id/run-pipeline',
  zValidator('json', runPipelineSchema.optional()),
  async (c) => {
    const user = c.get('user')
    if (!user) throw new UnauthorizedError()

    const db = c.get('db')
    const id = c.req.param('id')
    const resourceService = new ResourceService(db)
    await checkResourcePermission(db, user, resourceService, id)

    // `rebuildOnly` is the repair, not a variant of the run: an emptied
    // resource has nothing to rebuild from, and queueing one against it only
    // fails. The service reads which case applies so the caller does not have
    // to have kept the answer.
    if (c.req.valid('json')?.rebuildOnly) {
      const result = await new ResourceVersionService(db).repairDerivatives(id, {
        storage: c.get('storage'),
        search: c.get('search'),
        queue: c.get('queue'),
        logger: c.get('logger'),
      })
      return c.json({ id, ...result }, 200)
    }
    return c.json(await enqueuePipeline(c, id), 200)
  }
)

// POST /api/v1/resources/:id/cancel-pipeline - Stop the run processing this
// resource (ADR-044 §4). The content is left alone: putting it back is the next
// rung up, and not a decision to make for someone stopping a stuck run.
resourcesRouter.post('/:id/cancel-pipeline', async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

  // False means there was nothing running — reported rather than treated as an
  // error, since the caller's intent (this resource is not being processed) is
  // satisfied either way.
  return c.json({ id, cancelled: await cancelResourceRun(db, id) })
})

// POST /api/v1/resources/:id/revert - Stop the run and put the live content
// back to the newest surviving version (ADR-044 §4). For the wrong file having
// been uploaded: stopping alone leaves it live and downloadable.
resourcesRouter.post('/:id/revert', zValidator('json', revertResourceSchema), async (c) => {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError()

  const db = c.get('db')
  const id = c.req.param('id')
  const resourceService = new ResourceService(db)
  await checkResourcePermission(db, user, resourceService, id)

  const result = await new ResourceVersionService(db).revertLiveContent(id, c.req.valid('json'), {
    storage: c.get('storage'),
    search: c.get('search'),
    queue: c.get('queue'),
    logger: c.get('logger'),
  })
  return c.json({ id, ...result })
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
