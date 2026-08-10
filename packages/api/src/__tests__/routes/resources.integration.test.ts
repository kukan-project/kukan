import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Readable } from 'stream'
import {
  resource as resourceTable,
  resourcePipeline,
  resourcePipelineStep,
  resourceVersion,
} from '@kukan/db'
import { getStorageKey, MAX_UPLOAD_SIZE } from '@kukan/shared'
import { createTestApp, mockSearch } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  OUTSIDER_USER_ID,
  ensureOutsiderUser,
} from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)
const unauthApp = createTestApp(db, { user: null })
/** App with a mock storage that returns content (for preview tests) */
const storageWithContent = {
  upload: async () => {},
  download: async () => Readable.from(Buffer.from('fake-image-content')),
  downloadRange: async () => {
    const err = new Error('The specified key does not exist.')
    err.name = 'NoSuchKey'
    throw err
  },
  delete: async () => {},
  deleteByPrefix: async () => 0,
  getSignedUrl: async () => 'file:///test',
  getSignedUploadUrl: async () => 'https://minio.test/upload?signed=true',
  head: async () => ({ size: 1024 }),
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appWithStorage = createTestApp(db, { storage: storageWithContent as any })

/** Non-sysadmin user with no org membership */
const outsiderApp = createTestApp(db, {
  user: {
    id: OUTSIDER_USER_ID,
    email: 'outsider@example.com',
    name: 'outsider',
    sysadmin: false,
  },
})

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await closeTestDb()
})

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-org-res' }),
  })
  const org = await res.json()
  testOrgId = org.id
  return testOrgId
}

async function createPackage(name: string, options?: { private?: boolean }) {
  const orgId = await ensureTestOrg()
  const res = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ownerOrg: orgId, private: options?.private ?? false }),
  })
  return res.json()
}

async function createResource(packageId: string, data: Record<string, unknown> = {}) {
  const res = await app.request(`/api/v1/packages/${packageId}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-resource', format: 'CSV', ...data }),
  })
  const created = await res.json()
  // A resource is created before it has content; the content-serving endpoints
  // resolve `storage_key` (ADR-043), which a pipeline run would have set.
  await db
    .update(resourceTable)
    .set({ storageKey: `resources/${packageId}/${created.id}.test` })
    .where(eq(resourceTable.id, created.id))
  return created
}

describe('Resources API Routes', () => {
  // A rejected request has to say what was wrong: the raw ZodError the
  // validator used to return carries no `detail`, so clients reading Problem
  // Details had nothing to show and fell back to "it failed"
  describe('validation errors', () => {
    async function postResource(url: string) {
      const pkg = await createPackage(`invalid-url-pkg-${url.replace(/\W/g, '')}`)
      const res = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'r', url }),
      })
      return { status: res.status, body: await res.json() }
    }

    it('should report which field failed and why', async () => {
      const { status, body } = await postResource('example.com')

      expect(status).toBe(400)
      expect(body.title).toBe('VALIDATION_ERROR')
      expect(body.detail).toContain('url')
      expect(body.detail).toContain('Invalid URL')
      expect(body.details.issues[0].path).toEqual(['url'])
    })

    it('should report the scheme restriction by name', async () => {
      const { body } = await postResource('ftp://example.com/data.csv')

      expect(body.detail).toContain('Only http and https URLs are allowed')
    })

    it('should report a blocked host by name', async () => {
      const { body } = await postResource('http://169.254.169.254/latest/meta-data/')

      expect(body.detail).toContain('private or reserved')
    })
  })

  describe('GET /api/v1/resources/:id', () => {
    it('should return resource by ID', async () => {
      const pkg = await createPackage('res-test-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('test-resource')
    })

    it('should not expose the parent package ownership the access check loaded', async () => {
      const pkg = await createPackage('res-no-pkg-leak')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await res.json()
      expect(body).not.toHaveProperty('pkg')
    })

    it('should return 404 for non-existent', async () => {
      const res = await app.request('/api/v1/resources/550e8400-e29b-41d4-a716-446655440000')
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-res-pkg', { private: true })
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-res-pkg2', { private: true })
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(404)
    })

    it('should return resource for private package when user is sysadmin', async () => {
      const pkg = await createPackage('private-res-pkg3', { private: true })
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(200)
    })

    it('should return resource for private package when user is org member', async () => {
      const pkg = await createPackage('private-res-pkg4', { private: true })
      const resource = await createResource(pkg.id)

      // Add outsider as org member
      await app.request(`/api/v1/organizations/${testOrgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'member' }),
      })

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/v1/resources/:id/download — private visibility', () => {
    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-dl-pkg', { private: true })
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/download`)
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-dl-pkg2', { private: true })
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/download`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/resources/:id/text — private visibility', () => {
    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-text-pkg', { private: true })
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/text`)
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-text-pkg2', { private: true })
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/text`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/resources/:id/json', () => {
    const jsonContent = '{\n  "name": "test",\n  "value": 42\n}'
    const jsonContentBuf = Buffer.from(jsonContent)
    const jsonStorage = {
      ...storageWithContent,
      downloadRange: async () => ({
        stream: Readable.from([jsonContentBuf]),
        totalSize: jsonContentBuf.length,
        start: 0,
        end: jsonContentBuf.length - 1,
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appWithJson = createTestApp(db, { storage: jsonStorage as any })

    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-json-pkg', { private: true })
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-json-pkg2', { private: true })
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(404)
    })

    it('should return minified JSON with correct Content-Type', async () => {
      const pkg = await createPackage('json-serve-pkg')
      const resource = await createResource(pkg.id, { format: 'JSON' })

      const res = await appWithJson.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/json')

      const text = await res.text()
      expect(text).toBe('{"name":"test","value":42}')
    })

    it('should return application/geo+json for GeoJSON format', async () => {
      const pkg = await createPackage('geojson-ct-pkg')
      const resource = await createResource(pkg.id, { format: 'GeoJSON' })

      const res = await appWithJson.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    })

    it('should return 413 when resource.size exceeds limit', async () => {
      const pkg = await createPackage('json-toolarge-pkg')
      const resource = await createResource(pkg.id, { format: 'JSON' })

      // Set size > JSON_PREVIEW_LIMIT (10 MB) directly in DB
      await db
        .update(resourceTable)
        .set({ size: 11 * 1024 * 1024 })
        .where(eq(resourceTable.id, resource.id))

      const res = await appWithJson.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(413)

      const body = await res.json()
      expect(body.title).toBe('Payload Too Large')
    })

    it('should return 413 via storage totalSize when resource.size is null', async () => {
      const largeTotalSize = 11 * 1024 * 1024
      const largeStorage = {
        ...storageWithContent,
        downloadRange: async () => ({
          stream: Readable.from([Buffer.from('{}')]),
          totalSize: largeTotalSize,
          start: 0,
          end: 0,
        }),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const appWithLarge = createTestApp(db, { storage: largeStorage as any })

      const pkg = await createPackage('json-large-null-size-pkg')
      // resource.size is null (default from createResource)
      const resource = await createResource(pkg.id, { format: 'JSON' })

      const res = await appWithLarge.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(413)

      const body = await res.json()
      expect(body.title).toBe('Payload Too Large')
    })

    it('should return 415 for non-JSON format', async () => {
      const pkg = await createPackage('json-nonjson-pkg')
      const resource = await createResource(pkg.id, { format: 'CSV' })

      const res = await appWithJson.request(`/api/v1/resources/${resource.id}/json`)
      expect(res.status).toBe(415)

      const body = await res.json()
      expect(body.title).toBe('Unsupported Media Type')
    })
  })

  describe('GET /api/v1/resources/:id/preview — private visibility', () => {
    it('should return 404 for private package resource when unauthenticated', async () => {
      const pkg = await createPackage('private-prev-pkg', { private: true })
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(404)
    })

    it('should return 404 for private package resource when user is not org member', async () => {
      const pkg = await createPackage('private-prev-pkg2', { private: true })
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/resources/:id/preview — image formats', () => {
    it('should serve image preview directly without pipeline record', async () => {
      const pkg = await createPackage('img-preview-pkg')
      const resource = await createResource(pkg.id, { format: 'PNG' })

      const res = await appWithStorage.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/png')
    })

    it('should include X-Content-Type-Options: nosniff for all image previews', async () => {
      const pkg = await createPackage('img-nosniff-pkg')
      const resource = await createResource(pkg.id, { format: 'JPEG' })

      const res = await appWithStorage.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(200)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('should include CSP header for SVG to prevent stored XSS', async () => {
      const pkg = await createPackage('svg-csp-pkg')
      const resource = await createResource(pkg.id, { format: 'SVG' })

      const res = await appWithStorage.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; style-src 'unsafe-inline'"
      )
    })

    it('should not include CSP header for non-SVG images', async () => {
      const pkg = await createPackage('png-no-csp-pkg')
      const resource = await createResource(pkg.id, { format: 'PNG' })

      const res = await appWithStorage.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Security-Policy')).toBeNull()
    })

    it('should return 404 for non-previewable format without pipeline record', async () => {
      const pkg = await createPackage('rdf-no-preview-pkg')
      const resource = await createResource(pkg.id, { format: 'RDF' })

      const res = await appWithStorage.request(`/api/v1/resources/${resource.id}/preview`)
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/v1/resources/:id', () => {
    it('leaves the pipeline-owned columns untouched', async () => {
      // size/hash/extras are measured or produced by the worker. An edit must
      // not carry them at all — writing back what the request read would revert
      // whatever the pipeline recorded in between, and an upload is not
      // reprocessed on edit, so a stale hash would stick (ADR-043).
      const pkg = await createPackage('put-preserves-pkg')
      const resource = await createResource(pkg.id)
      await db
        .update(resourceTable)
        .set({ size: 1234, hash: 'sha256:worker-measured', extras: { pipeline: 'state' } })
        .where(eq(resourceTable.id, resource.id))

      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed', size: 99, hash: 'sha256:caller-supplied' }),
      })
      expect(res.status).toBe(200)

      const [row] = await db
        .select({
          size: resourceTable.size,
          hash: resourceTable.hash,
          extras: resourceTable.extras,
        })
        .from(resourceTable)
        .where(eq(resourceTable.id, resource.id))
      expect(row).toEqual({
        size: 1234,
        hash: 'sha256:worker-measured',
        extras: { pipeline: 'state' },
      })
    })

    it('should update resource', async () => {
      const pkg = await createPackage('update-res-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'updated-resource', format: 'JSON' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('updated-resource')
      expect(body.format).toBe('JSON')
    })

    it('should clear omitted optional fields (PUT semantics)', async () => {
      const pkg = await createPackage('put-clear-res-pkg')
      const resource = await createResource(pkg.id, {
        name: 'original',
        description: 'to be cleared',
        format: 'CSV',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'kept' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('kept')
      expect(body.description).toBeNull()
      expect(body.format).toBeNull()
    })

    it('should preserve system-managed extras on PUT', async () => {
      const pkg = await createPackage('extras-preserve-pkg')
      const resource = await createResource(pkg.id, { name: 'with-extras' })

      // Set extras directly via DB (simulating pipeline metadata)
      await db
        .update(resourceTable)
        .set({ extras: { pipeline_version: '2', content_hash: 'abc123' } })
        .where(eq(resourceTable.id, resource.id))

      // PUT update — should NOT clear extras
      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('renamed')
      expect(body.extras).toEqual({ pipeline_version: '2', content_hash: 'abc123' })
    })

    it('should enqueue pipeline when resource has an external URL', async () => {
      const pkg = await createPackage('update-enqueue-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      // Metadata-only update on resource with URL
      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'updated description' }),
      })
      expect(res.status).toBe(200)

      // Pipeline should be queued
      const statusRes = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      const statusBody = await statusRes.json()
      expect(statusBody.pipeline_status).toBe('queued')
    })

    it('should not enqueue pipeline when resource has no URL', async () => {
      const pkg = await createPackage('update-no-url-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'no url resource' }),
      })
      expect(res.status).toBe(200)

      // Pipeline should NOT be queued
      const statusRes = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      const statusBody = await statusRes.json()
      expect(statusBody.pipeline_status).toBeNull()
    })

    it('should succeed even if pipeline enqueue fails', async () => {
      const pkg = await createPackage('update-enqueue-fail-pkg')
      const resource = await createResource(pkg.id)

      // Update should succeed regardless of pipeline result
      const res = await app.request(`/api/v1/resources/${resource.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'still-updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('still-updated')
    })
  })

  describe('DELETE /api/v1/resources/:id', () => {
    it('should soft delete resource and clean up search indices', async () => {
      const pkg = await createPackage('delete-res-pkg')
      const resource = await createResource(pkg.id)

      vi.mocked(mockSearch.deleteResource).mockClear()
      vi.mocked(mockSearch.deleteContent).mockClear()

      const res = await app.request(`/api/v1/resources/${resource.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.state).toBe('deleted')
      expect(mockSearch.deleteResource).toHaveBeenCalledWith(resource.id)
      expect(mockSearch.deleteContent).toHaveBeenCalledWith(resource.id)
    })
  })

  describe('Auto-position assignment', () => {
    it('should auto-assign sequential positions', async () => {
      const pkg = await createPackage('position-test')
      const res1 = await createResource(pkg.id, { name: 'first' })
      const res2 = await createResource(pkg.id, { name: 'second' })
      const res3 = await createResource(pkg.id, { name: 'third' })

      expect(res1.position).toBe(0)
      expect(res2.position).toBe(1)
      expect(res3.position).toBe(2)
    })
  })

  describe('PUT /api/v1/packages/:packageId/resources/reorder', () => {
    it('should reorder resources by resourceIds order', async () => {
      const pkg = await createPackage('reorder-pkg')
      const res1 = await createResource(pkg.id, { name: 'first' })
      const res2 = await createResource(pkg.id, { name: 'second' })
      const res3 = await createResource(pkg.id, { name: 'third' })

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: [res3.id, res1.id, res2.id] }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
      expect(body[0].id).toBe(res3.id)
      expect(body[0].position).toBe(0)
      expect(body[1].id).toBe(res1.id)
      expect(body[1].position).toBe(1)
      expect(body[2].id).toBe(res2.id)
      expect(body[2].position).toBe(2)
    })

    it('should reject partial resourceIds (missing IDs)', async () => {
      const pkg = await createPackage('reorder-partial-pkg')
      const res1 = await createResource(pkg.id, { name: 'first' })
      await createResource(pkg.id, { name: 'second' })

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: [res1.id] }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject duplicate IDs in resourceIds', async () => {
      const pkg = await createPackage('reorder-dup-pkg')
      const res1 = await createResource(pkg.id, { name: 'first' })
      const res2 = await createResource(pkg.id, { name: 'second' })

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: [res1.id, res1.id, res2.id] }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject IDs that do not belong to the package', async () => {
      const pkg1 = await createPackage('reorder-other-pkg-1')
      const pkg2 = await createPackage('reorder-other-pkg-2')
      const other = await createResource(pkg2.id, { name: 'other' })
      const own = await createResource(pkg1.id, { name: 'own' })

      const res = await app.request(`/api/v1/packages/${pkg1.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: [own.id, other.id] }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject invalid UUIDs', async () => {
      const pkg = await createPackage('reorder-invalid-pkg')

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: ['not-a-uuid'] }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject unauthenticated requests', async () => {
      const pkg = await createPackage('reorder-unauth-pkg')
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/packages/${pkg.id}/resources/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds: [resource.id] }),
      })
      expect(res.status).toBe(401)
    })
  })

  // --- Upload flow ---

  describe('POST /api/v1/resources/:id/upload-url', () => {
    it('should return presigned upload URL', async () => {
      const pkg = await createPackage('upload-url-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.upload_url).toBeDefined()
      expect(typeof body.upload_url).toBe('string')
    })

    it('leaves the resource describing what it still serves', async () => {
      // The upload has only been offered a URL — nothing has been written yet,
      // and abandoning it must not leave the resource claiming to be the file
      // that never arrived (ADR-043).
      const pkg = await createPackage('upload-url-type-pkg')
      const resource = await createResource(pkg.id)

      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })

      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.url).not.toBe('data.csv')
      expect(body.urlType).not.toBe('upload')
      // Held server-side until the upload lands; never part of the response.
      expect(body).not.toHaveProperty('pendingMetadata')
    })

    it('should reject unauthenticated requests', async () => {
      const pkg = await createPackage('upload-url-unauth-pkg')
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })
      expect(res.status).toBe(401)
    })

    it('should reject invalid input (missing filename)', async () => {
      const pkg = await createPackage('upload-url-invalid-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'text/csv' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/v1/resources/:id/upload', () => {
    it('should accept multipart file upload', async () => {
      const pkg = await createPackage('upload-pkg')
      const resource = await createResource(pkg.id)

      const formData = new FormData()
      const file = new File(['col1,col2\na,b'], 'data.csv', { type: 'text/csv' })
      formData.append('file', file)

      const res = await app.request(`/api/v1/resources/${resource.id}/upload`, {
        method: 'POST',
        body: formData,
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.pipeline_status).toBe('queued')
      expect(body.job_id).toBeDefined()
    })

    it('should update resource metadata after upload', async () => {
      const pkg = await createPackage('upload-meta-pkg')
      const resource = await createResource(pkg.id)

      const formData = new FormData()
      const content = 'col1,col2\na,b'
      const file = new File([content], 'data.csv', { type: 'text/csv' })
      formData.append('file', file)

      await app.request(`/api/v1/resources/${resource.id}/upload`, {
        method: 'POST',
        body: formData,
      })

      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.urlType).toBe('upload')
      expect(body.url).toBe('data.csv')
      expect(body.size).toBe(content.length)
    })

    it('should reject request without file', async () => {
      const pkg = await createPackage('upload-nofile-pkg')
      const resource = await createResource(pkg.id)

      const formData = new FormData()
      formData.append('other', 'value')

      const res = await app.request(`/api/v1/resources/${resource.id}/upload`, {
        method: 'POST',
        body: formData,
      })
      expect(res.status).toBe(400)
    })

    it('should reject unauthenticated requests', async () => {
      const pkg = await createPackage('upload-unauth-pkg')
      const resource = await createResource(pkg.id)

      const formData = new FormData()
      formData.append('file', new File(['data'], 'test.csv', { type: 'text/csv' }))

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/upload`, {
        method: 'POST',
        body: formData,
      })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/v1/resources/:id/upload-complete', () => {
    it('should enqueue pipeline and return queued status', async () => {
      const pkg = await createPackage('complete-pkg')
      const resource = await createResource(pkg.id)

      // First, prepare the resource via upload-url to set urlType='upload'
      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 2048, hash: 'sha256:abc' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.pipeline_status).toBe('queued')
      expect(body.job_id).toBeDefined()
    })

    it('records the stored size and leaves the hash for the worker to compute', async () => {
      const pkg = await createPackage('complete-meta-pkg')
      const resource = await createResource(pkg.id)

      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })

      await app.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Client claims 4096, but the server records the real object size (mock head → 1024).
        // A hash is not accepted at all: version create gates on it (ADR-043),
        // so the caller must not be able to decide what it says.
        body: JSON.stringify({ size: 4096, hash: 'sha256:def' }),
      })

      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.size).toBe(1024)
      expect(body.hash).toBeNull()
    })

    it('should reject an upload whose stored size exceeds the limit', async () => {
      const oversizeStorage = {
        ...storageWithContent,
        head: async () => ({ size: MAX_UPLOAD_SIZE + 1 }),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oversizeApp = createTestApp(db, { storage: oversizeStorage as any })
      const pkg = await createPackage('complete-oversize-pkg')
      const resource = await createResource(pkg.id)

      await oversizeApp.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'big.csv', contentType: 'text/csv' }),
      })

      const res = await oversizeApp.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 10 }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject if resource is not an upload', async () => {
      const pkg = await createPackage('complete-notupload-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('should reject unauthenticated requests', async () => {
      const pkg = await createPackage('complete-unauth-pkg')
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/resources/:id/pipeline-status', () => {
    it('should return null status when no pipeline exists', async () => {
      const pkg = await createPackage('pipeline-status-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.id).toBe(resource.id)
      expect(body.pipeline_status).toBeNull()
      expect(body.steps).toEqual([])
    })

    it('should return pipeline status after upload', async () => {
      const pkg = await createPackage('pipeline-status-upload-pkg')
      const resource = await createResource(pkg.id)

      // Trigger pipeline via upload flow
      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })
      await app.request(`/api/v1/resources/${resource.id}/upload-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.pipeline_status).toBe('queued')
      expect(body.updated).toBeDefined()
    })

    it('should redact error details for non-sysadmin users', async () => {
      const pkg = await createPackage('pipeline-error-redact-pkg')
      const resource = await createResource(pkg.id)

      // Insert pipeline with an error containing internal details
      const [pipeline] = await db
        .insert(resourcePipeline)
        .values({
          resourceId: resource.id,
          status: 'error',
          error: 'S3 bucket kukan-prod: AccessDenied at /internal/path',
        })
        .returning()

      await db.insert(resourcePipelineStep).values({
        pipelineId: pipeline.id,
        stepName: 'fetch',
        status: 'error',
        error: 'Connection refused to 10.0.1.42:9000',
      })

      // Sysadmin sees raw error
      const adminRes = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      const adminBody = await adminRes.json()
      expect(adminBody.error).toContain('S3 bucket kukan-prod')
      expect(adminBody.steps[0].error).toContain('10.0.1.42')

      // Non-sysadmin sees generic message
      const outsiderRes = await outsiderApp.request(
        `/api/v1/resources/${resource.id}/pipeline-status`
      )
      const outsiderBody = await outsiderRes.json()
      expect(outsiderBody.error).toBe('Processing failed')
      expect(outsiderBody.steps[0].error).toBe('Processing failed')
      expect(JSON.stringify(outsiderBody)).not.toContain('kukan-prod')
      expect(JSON.stringify(outsiderBody)).not.toContain('10.0.1.42')
    })

    it('should show the reason to someone who may edit the resource', async () => {
      // They entered the URL, so "Processing failed" leaves them with nothing
      // to act on — the redaction above is for everyone else
      const pkg = await createPackage('pipeline-error-editor-pkg')
      const resource = await createResource(pkg.id)
      await app.request(`/api/v1/organizations/${testOrgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: OUTSIDER_USER_ID, role: 'editor' }),
      })

      await db.insert(resourcePipeline).values({
        resourceId: resource.id,
        status: 'error',
        error: 'fetch failed: 404 Not Found',
      })

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      const body = await res.json()
      expect(body.error).toBe('fetch failed: 404 Not Found')
    })

    it('should return 404 for a draft resource to anonymous users (ADR-039)', async () => {
      const draftRes = await app.request('/api/v1/packages/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const draft = await draftRes.json()
      const resource = await createResource(draft.id)

      const anon = await unauthApp.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      expect(anon.status).toBe(404)

      // The creator still sees the status
      const mine = await app.request(`/api/v1/resources/${resource.id}/pipeline-status`)
      expect(mine.status).toBe(200)
    })
  })

  describe('GET /api/v1/resources/:id/schema (ADR-032)', () => {
    const schema = {
      rowCount: 2,
      columns: [
        { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
        { name: 'name', type: 'string', nullable: true, nullCount: 1 },
      ],
    }

    it('returns queryable=false when no schema is stored', async () => {
      const pkg = await createPackage('schema-none-pkg')
      const resource = await createResource(pkg.id, { name: 'no-schema.csv' })

      const res = await app.request(`/api/v1/resources/${resource.id}/schema`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: resource.id, queryable: false, schema: null })
    })

    it('returns the stored schema with queryable=true', async () => {
      const pkg = await createPackage('schema-pkg')
      const resource = await createResource(pkg.id, { name: 'with-schema.csv' })
      // A pipeline row already exists (created when the resource was enqueued),
      // so upsert the schema into its metadata.
      await db
        .insert(resourcePipeline)
        .values({ resourceId: resource.id, status: 'complete', metadata: { schema } })
        .onConflictDoUpdate({
          target: resourcePipeline.resourceId,
          set: { status: 'complete', metadata: { schema } },
        })

      const res = await app.request(`/api/v1/resources/${resource.id}/schema`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: resource.id, queryable: true, schema })
    })

    it('denies access to a private resource for unauthenticated users', async () => {
      const pkg = await createPackage('schema-private-pkg', { private: true })
      const resource = await createResource(pkg.id, { name: 'secret.csv' })
      // A pipeline row already exists (created when the resource was enqueued),
      // so upsert the schema into its metadata.
      await db
        .insert(resourcePipeline)
        .values({ resourceId: resource.id, status: 'complete', metadata: { schema } })
        .onConflictDoUpdate({
          target: resourcePipeline.resourceId,
          set: { status: 'complete', metadata: { schema } },
        })

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/schema`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/resources/:id/download', () => {
    it('should redirect to external URL for non-upload resource', async () => {
      const pkg = await createPackage('dl-ext-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/download`, {
        redirect: 'manual',
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toBe('https://example.com/data.csv')
    })

    it('should return 404 for non-existent resource', async () => {
      const res = await app.request(
        '/api/v1/resources/550e8400-e29b-41d4-a716-446655440000/download'
      )
      expect(res.status).toBe(404)
    })

    it('should return 404 when file is missing from storage (NoSuchKey)', async () => {
      const pkg = await createPackage('dl-missing-pkg')
      const resource = await createResource(pkg.id, {
        url: 'missing.csv',
        urlType: 'upload',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/download`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/resources/formats', () => {
    it('should return distinct formats', async () => {
      const pkg = await createPackage('formats-pkg')
      await createResource(pkg.id, { format: 'CSV' })
      await createResource(pkg.id, { format: 'JSON' })
      await createResource(pkg.id, { format: 'CSV' }) // duplicate

      const res = await app.request('/api/v1/resources/formats')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toContain('CSV')
      expect(body).toContain('JSON')
      // Should not have duplicates
      expect(body.filter((f: string) => f === 'CSV')).toHaveLength(1)
    })

    it('should return empty array when no resources exist', async () => {
      const res = await app.request('/api/v1/resources/formats')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual([])
    })
  })

  describe('POST /api/v1/resources/:id/run-pipeline', () => {
    it('should enqueue pipeline for authenticated user', async () => {
      const pkg = await createPackage('run-pipeline-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/run-pipeline`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.pipeline_status).toBe('queued')
      expect(body.job_id).toBeDefined()
    })

    it('repairs by rebuilding, without fetching', async () => {
      // The safe repair after a revert, reachable from the screen alone rather
      // than only by resending a request someone had to keep (ADR-044 §4).
      const pkg = await createPackage('run-pipeline-rebuild-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/run-pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rebuildOnly: true }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ queued: true, cleared: null })
    })

    it('should return 401 for unauthenticated users', async () => {
      const pkg = await createPackage('run-pipeline-unauth-pkg')
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/run-pipeline`, {
        method: 'POST',
      })
      expect(res.status).toBe(401)
    })

    it('should return 404 for nonexistent resource', async () => {
      const res = await app.request(
        '/api/v1/resources/00000000-0000-0000-0000-000000000099/run-pipeline',
        { method: 'POST' }
      )
      expect(res.status).toBe(404)
    })
  })

  // ADR-043 layer 2. The diff scans both snapshots in full, so unlike the other
  // version routes it is gated on edit rights rather than visibility — ii-a puts
  // it in the dashboard, and public diffs are Phase iii.
  describe('GET /api/v1/resources/:id/versions/:v/diff', () => {
    it('should return 401 for unauthenticated users even on a public dataset', async () => {
      const pkg = await createPackage('diff-unauth-pkg')
      const resource = await createResource(pkg.id)

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/versions/1/diff`)
      expect(res.status).toBe(401)
    })

    it('should return 403 for a user who cannot edit the dataset', async () => {
      const pkg = await createPackage('diff-outsider-pkg')
      const resource = await createResource(pkg.id)

      const res = await outsiderApp.request(`/api/v1/resources/${resource.id}/versions/1/diff`)
      expect(res.status).toBe(403)
    })

    it('should report no previous version for an editor when v1 is all there is', async () => {
      const pkg = await createPackage('diff-editor-pkg')
      const resource = await createResource(pkg.id)
      await db.insert(resourceVersion).values({
        resourceId: resource.id,
        version: 1,
        storageKey: getStorageKey(pkg.id, resource.id, 'v1'),
        hash: 'sha256:v1',
        origin: 'upload',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/versions/1/diff`)
      expect(res.status).toBe(200)
      // Resolved without ever opening a lake session.
      expect(await res.json()).toMatchObject({ available: false, reason: 'no-previous-version' })
      // An answer that can change the moment the backfill runs is not cached.
      expect(res.headers.get('Cache-Control')).toBeNull()
    })

    it('should not cache the answer a purge leaves behind', async () => {
      // The end of the story this route got wrong: it promised a computed diff
      // was `immutable` for a day, and purging a version destroys the snapshot
      // it was read from — so a legally deleted version's rows stayed on screen,
      // past a reload, for anyone who had opened that diff. What a purge leaves
      // is this, and it must not be held at all.
      const pkg = await createPackage('diff-purged-pkg')
      const resource = await createResource(pkg.id)
      await db.insert(resourceVersion).values({
        resourceId: resource.id,
        version: 1,
        storageKey: getStorageKey(pkg.id, resource.id, 'v1'),
        hash: 'sha256:v1',
        origin: 'upload',
        state: 'purged',
      })
      await db.insert(resourceVersion).values({
        resourceId: resource.id,
        version: 2,
        storageKey: getStorageKey(pkg.id, resource.id, 'v2'),
        hash: 'sha256:v2',
        origin: 'upload',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/versions/2/diff`)

      expect(await res.json()).toMatchObject({ available: false, reason: 'purged' })
      expect(res.headers.get('Cache-Control')).toBeNull()
    })
  })
})
