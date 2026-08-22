import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Readable } from 'stream'
import { randomUUID } from 'node:crypto'
import {
  resource as resourceTable,
  resourcePipeline,
  resourcePipelineStep,
  resourceVersion,
} from '@kukan/db'
import { getStorageKey, MAX_UPLOAD_SIZE } from '@kukan/shared'
import { createTestApp, mockQueue, mockSearch } from '../test-helpers/test-app'
import { CLAIM_STALE_AFTER_MS } from '../../services/pipeline-claim'
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

    it('should not expose what the health checker recorded for itself', async () => {
      // It names the address a URL resolved to and the reason a certificate was
      // rejected. Sysadmins read it on the health screen; this response is
      // anonymous, and a sysadmin asking is still asking as a reader.
      const pkg = await createPackage('res-no-health-state')
      const resource = await createResource(pkg.id)
      await db
        .update(resourceTable)
        .set({ healthCheckState: { error: 'connect ECONNREFUSED 10.0.3.17:443' } })
        .where(eq(resourceTable.id, resource.id))

      const res = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await res.json()
      expect(body).not.toHaveProperty('healthCheckState')
      expect(JSON.stringify(body)).not.toContain('10.0.3.17')
    })

    it('should scrub the keys the checker used to write onto extras', async () => {
      // Why the row can still have them after 0035, and why the read has to
      // scrub rather than wait for the checker: `LEGACY_HEALTH_EXTRAS_KEYS`.
      const pkg = await createPackage('res-legacy-health-extras')
      const resource = await createResource(pkg.id)
      await db
        .update(resourceTable)
        .set({
          extras: { healthEtag: '"v1"', healthError: 'HTTP 404', theirs: 'keep me' },
        })
        .where(eq(resourceTable.id, resource.id))

      // Reads the whole table, so this one is scrubbed in JS.
      const res = await app.request(`/api/v1/resources/${resource.id}`)
      expect((await res.json()).extras).toEqual({ theirs: 'keep me' })

      // Same, by way of the CKAN action the reviewer of #358 named.
      const ckan = await app.request(`/api/3/action/resource_show?id=${resource.id}`)
      expect((await ckan.json()).result.extras).toEqual({ theirs: 'keep me' })

      // And the projected read, which scrubs in SQL.
      const listed = await app.request(`/api/v1/packages/${pkg.id}`)
      const pkgBody = await listed.json()
      const listedResource = pkgBody.resources.find((r: { id: string }) => r.id === resource.id)
      expect(listedResource.extras).toEqual({ theirs: 'keep me' })
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

  describe('GET /api/v1/resources/:id/versions', () => {
    it('should not hand a purge reason to a reader of the resource', async () => {
      // The list is gated on the resource's visibility alone, so on a public
      // dataset this is an anonymous read. A purge reason is free text about
      // content that was destroyed — for a takedown it can describe the very
      // thing that had to go — so it is not on the view at all (#425). Asserted
      // on the response, because that is the surface the issue was about.
      const pkg = await createPackage('versions-reason-pkg')
      const resource = await createResource(pkg.id)
      await db.insert(resourceVersion).values({
        resourceId: resource.id,
        version: 1,
        storageKey: getStorageKey(pkg.id, resource.id, 'v1'),
        hash: 'sha256:v1',
        origin: 'upload',
        state: 'purged',
        purgedAt: new Date(),
        purgeReason: 'names the complainant',
      })

      const res = await unauthApp.request(`/api/v1/resources/${resource.id}/versions`)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.versions).toHaveLength(1)
      expect(body.versions[0]).not.toHaveProperty('purgeReason')
      // Not by serialising to nothing, either: the whole body must not carry it.
      expect(JSON.stringify(body)).not.toContain('complainant')
      // The date stays — it explains the gap in version numbers.
      expect(body.versions[0].purgedAt).not.toBeNull()
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
      // it was read from — so a purged version's rows stayed on screen, past a
      // reload, for anyone who had opened that diff. What a purge leaves
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

describe('PUT /api/v1/resources/:id/column-settings', () => {
  /**
   * A resource whose live version records these columns — the artifact the
   * check reads, and the one the ingest will read later (spec §6.4).
   */
  async function withColumns(
    name: string,
    columns: string[],
    stats: { rowCount?: number; distinctCount?: number; nullCount?: number } = {}
  ) {
    const pkg = await createPackage(name)
    const resource = await createResource(pkg.id)
    const [live] = await db
      .select({ storageKey: resourceTable.storageKey })
      .from(resourceTable)
      .where(eq(resourceTable.id, resource.id))
    await db.insert(resourceVersion).values({
      resourceId: resource.id,
      version: 1,
      storageKey: live.storageKey!,
      size: 100,
      hash: 'sha256:v1',
      origin: 'upload',
      format: 'csv',
      schema: {
        rowCount: stats.rowCount ?? 2,
        columns: columns.map((column) => ({
          name: column,
          type: 'string' as const,
          nullable: false,
          nullCount: stats.nullCount ?? 0,
          ...(stats.distinctCount === undefined ? {} : { distinctCount: stats.distinctCount }),
        })),
      },
    })
    return resource
  }

  const setKey = (id: string, primaryKey: string[] | null) =>
    app.request(`/api/v1/resources/${id}/column-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey }),
    })

  const storedSettings = async (id: string) =>
    (
      await db
        .select({ settings: resourceTable.columnSettings })
        .from(resourceTable)
        .where(eq(resourceTable.id, id))
    )[0].settings

  it('settles the key and queues the run that carries it into a version', async () => {
    // The version is the gate's to create — this says a job is on its way and
    // nothing more (spec §6.4).
    const resource = await withColumns('key-set-pkg', ['order', 'line'])

    const res = await setKey(resource.id, ['order', 'line'])

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ primaryKey: ['order', 'line'], queued: true })
    expect(await storedSettings(resource.id)).toEqual({ primaryKey: ['order', 'line'] })
  })

  it('queues nothing once a version carries the key', async () => {
    // A picker sends back what it was shown. What settles it is the version, not
    // the setting: the run this queued would create no version, since the gate
    // would find nothing to tell apart.
    const resource = await withColumns('key-same-pkg', ['id'])
    await setKey(resource.id, ['id'])
    await db
      .update(resourceVersion)
      .set({ lakeKeyColumns: ['id'] })
      .where(eq(resourceVersion.resourceId, resource.id))

    const res = await setKey(resource.id, ['id'])

    expect(await res.json()).toMatchObject({ primaryKey: ['id'], queued: null })
  })

  it('queues once when the same settle is sent twice before the version exists', async () => {
    // The version cannot carry the key until the run reaches its Version step,
    // so "not carried yet" is true of a resend seconds later. The job already on
    // its way is what settles it — a second one would arrive to find the version
    // made and the gate with nothing to tell apart.
    const resource = await withColumns('key-double-send-pkg', ['id'])
    vi.mocked(mockQueue.enqueue).mockClear()

    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: true })
    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: null })

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('waits for a long run whose current step has just started', async () => {
    // `startStep` dates the run on the step row, not on `resource_pipeline`, and
    // the claim's own liveness is judged from the newer of the claim and the
    // last step start. Read by `updated` alone, a run past the window but still
    // working would look dead here — and the second rebuild would arrive behind
    // it, after `enqueue` had already put the row back to `queued`.
    const resource = await withColumns('key-long-run-pkg', ['id'])
    await setKey(resource.id, ['id'])
    const [pipeline] = await db
      .update(resourcePipeline)
      .set({
        status: 'processing',
        updated: new Date(Date.now() - CLAIM_STALE_AFTER_MS - 1000),
        claimOwner: randomUUID(),
        claimKind: 'run',
        claimOwnerAt: new Date(Date.now() - CLAIM_STALE_AFTER_MS - 1000),
      })
      .where(eq(resourcePipeline.resourceId, resource.id))
      .returning({ id: resourcePipeline.id })
    await db.insert(resourcePipelineStep).values({
      pipelineId: pipeline.id,
      stepName: 'interpret',
      status: 'running',
      startedAt: new Date(),
    })
    vi.mocked(mockQueue.enqueue).mockClear()

    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: null })
    expect(mockQueue.enqueue).not.toHaveBeenCalled()
  })

  it('re-queues once a row left `queued` is too old to be waiting for', async () => {
    // The crash window `PipelineService.enqueue` leaves: the row is written
    // before the message is sent, so a process that dies in between leaves
    // `queued` with nothing in the queue. Trusted bare, that row would suppress
    // every resend and the setting would have no way of reaching a version.
    const resource = await withColumns('key-stale-queued-pkg', ['id'])
    await setKey(resource.id, ['id'])
    await db
      .update(resourcePipeline)
      .set({ updated: new Date(Date.now() - CLAIM_STALE_AFTER_MS - 1000) })
      .where(eq(resourcePipeline.resourceId, resource.id))
    vi.mocked(mockQueue.enqueue).mockClear()

    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: true })
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('re-queues on a resend when the first enqueue failed', async () => {
    // The setting is saved either way, so a resend finds nothing to write — and
    // nothing sweeps up a resource whose setting and newest version disagree.
    // Asking the version rather than the setting is what makes the resend the
    // repair.
    const resource = await withColumns('key-requeue-pkg', ['id'])
    // The enqueue puts the row back to `error` when the queue refuses it, so the
    // "a run is already on its way" guard does not catch this resend.
    vi.mocked(mockQueue.enqueue).mockRejectedValueOnce(new Error('queue is down'))

    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: false })

    expect(await (await setKey(resource.id, ['id'])).json()).toMatchObject({ queued: true })
  })

  it('queues nothing for a resource with no versions to carry the key', async () => {
    // The first version it gets freezes the setting at its own creation, so
    // there is no run owed — and repeated calls do not pile up jobs that can
    // only fail on a resource with nothing to rebuild from.
    const pkg = await createPackage('key-no-versions-pkg')
    const resource = await createResource(pkg.id)

    expect(await (await setKey(resource.id, null)).json()).toMatchObject({ queued: null })
  })

  it('moves the resource timestamp, because a person changed it', async () => {
    const resource = await withColumns('key-updated-pkg', ['id'])
    const [before] = await db
      .select({ updated: resourceTable.updated })
      .from(resourceTable)
      .where(eq(resourceTable.id, resource.id))

    await setKey(resource.id, ['id'])

    const [after] = await db
      .select({ updated: resourceTable.updated })
      .from(resourceTable)
      .where(eq(resourceTable.id, resource.id))
    expect(after.updated.getTime()).toBeGreaterThan(before.updated.getTime())
  })

  it('takes the key off, and treats an empty list as taking it off', async () => {
    const resource = await withColumns('key-unset-pkg', ['id'])
    await setKey(resource.id, ['id'])
    // The run landed: the newest version carries the key that is now being
    // taken off, so going keyless is a change a version still has to record.
    await db
      .update(resourceVersion)
      .set({ lakeKeyColumns: ['id'] })
      .where(eq(resourceVersion.resourceId, resource.id))

    expect(await (await setKey(resource.id, [])).json()).toMatchObject({
      primaryKey: null,
      queued: true,
    })
    expect(await storedSettings(resource.id)).toEqual({})
  })

  it('refuses a column the live version does not have', async () => {
    // Refused now rather than left to become a `lake_ingest_reason` hours later
    // (spec §6.6) — though the columns can still move under a key that was valid
    // when it was set, which is what that reason records.
    const resource = await withColumns('key-missing-col-pkg', ['id'])

    const res = await setKey(resource.id, ['nope'])

    expect(res.status).toBe(400)
    expect((await res.json()).detail).toContain('nope')
  })

  it('reads the live version, not the cached interpretation', async () => {
    // The cached one is the worker's to rewrite, and a run whose Interpret
    // failed leaves it describing the content before this one. A key picked off
    // that stale list would pass here and reach the ingest as `key-missing`.
    const resource = await withColumns('key-stale-cache-pkg', ['id'])
    await db.insert(resourcePipeline).values({
      resourceId: resource.id,
      metadata: {
        schema: {
          rowCount: 1,
          columns: [{ name: 'gone', type: 'string', nullable: false, nullCount: 0 }],
        },
      },
    })

    expect((await setKey(resource.id, ['gone'])).status).toBe(400)
    expect((await setKey(resource.id, ['id'])).status).toBe(200)
  })

  it('refuses a key on a resource with no interpreted columns', async () => {
    const pkg = await createPackage('key-no-schema-pkg')
    const resource = await createResource(pkg.id)

    expect((await setKey(resource.id, ['id'])).status).toBe(400)
  })

  it('answers before the key is applied, without reading content for a missing column', async () => {
    // The half the picker gets wrong most easily, and the one that needs no
    // scan: a column the live version does not have. Answered here rather than
    // becoming a `lake_ingest_reason` hours later on a version created
    // regardless (spec §6.4) — and the unusable lake config proves no session
    // was opened to find it out.
    const resource = await withColumns('key-check-missing-pkg', ['id'])

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['nope'] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ primaryKey: ['nope'], fault: 'key-missing' })
  })

  it('answers that taking the key off always applies', async () => {
    const resource = await withColumns('key-check-none-pkg', ['id'])

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: null }),
    })

    expect(await res.json()).toMatchObject({ primaryKey: null, fault: null })
  })

  it('says a single-column key is fine from what the version already recorded', async () => {
    // The interpretation counted nulls and whether the values identify a row,
    // and froze both (ADR-046) — the same numbers the picker offers candidates
    // from. No scan, and the unusable lake config proves none was opened.
    const resource = await withColumns('key-check-unique-pkg', ['id'], { distinctCount: 2 })

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['id'] }),
    })

    expect(await res.json()).toMatchObject({ checked: true, fault: null })
  })

  it('says which of the two a recorded non-unique column fails on', async () => {
    const resource = await withColumns('key-check-dupes-pkg', ['id'], {
      distinctCount: 1,
      nullCount: 0,
    })

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['id'] }),
    })

    expect(await res.json()).toMatchObject({ checked: true, fault: 'key-not-unique' })
  })

  it('offers the columns the apply will validate against, and where the key stands', async () => {
    // From the live version's frozen interpretation, not the resource's cached
    // one: offered from the cache, a picker would list columns the apply then
    // refuses with 400, and "which schema is authoritative" would have a second
    // implementation on the browser's side of the network.
    const resource = await withColumns('key-read-pkg', ['id', 'name'], { distinctCount: 2 })
    await setKey(resource.id, ['id'])

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: resource.id,
      primaryKey: ['id'],
      // No version was read under it yet, so a rebuild is owed — a state the
      // screen names rather than treating as a fault.
      carried: false,
      schema: {
        rowCount: 2,
        columns: [
          { name: 'id', distinctCount: 2 },
          { name: 'name', distinctCount: 2 },
        ],
      },
    })
  })

  it('says the sample cannot be shown when the preview describes other bytes', async () => {
    // The same predicate the check reports as `preview-stale`: a run whose
    // Interpret failed leaves the previous content's preview in place, and a
    // picker showing rows off it would be choosing a key over content the
    // resource does not serve.
    const resource = await withColumns('key-read-stale-pkg', ['id'], { distinctCount: 2 })
    await db.insert(resourcePipeline).values({
      resourceId: resource.id,
      previewKey: 'previews/pkg/res.parquet',
      metadata: { sourceHash: 'sha256:something-else' },
    })

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings`)

    expect(await res.json()).toMatchObject({ preview: 'preview-stale' })
  })

  it('trusts a preview from before the source hash existed', async () => {
    // Nothing to compare a hash against, so the completed run is the proof —
    // the fallback `schemaDescribesLiveContent` carries and a bare
    // `sourceHash !== hash` misses. Without it every interpretation predating
    // ADR-046 reads as stale for good, and the rebuild offered beside the
    // message cannot settle it.
    const resource = await withColumns('key-read-prehash-pkg', ['id'], { distinctCount: 2 })
    const [pipeline] = await db
      .insert(resourcePipeline)
      .values({
        resourceId: resource.id,
        previewKey: 'previews/pkg/res.parquet',
        status: 'complete',
        metadata: {},
      })
      .returning()
    await db
      .insert(resourcePipelineStep)
      .values({ pipelineId: pipeline.id, stepName: 'extract', status: 'complete' })

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings`)

    expect(await res.json()).toMatchObject({ preview: 'ready' })
  })

  it('answers for a resource with nothing interpreted yet', async () => {
    // The picker has nothing to offer, which is not the same as an error: the
    // resource exists and its setting is readable.
    const pkg = await createPackage('key-read-empty-pkg')
    const resource = await createResource(pkg.id)

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      primaryKey: null,
      carried: true,
      schema: null,
      preview: 'no-preview',
    })
  })

  it('accepts a key on an empty table, because the ingest would', async () => {
    // A header-only CSV interprets to rowCount 0, and `unique` false with it —
    // there is nothing to be distinct. But `keyFault` counts, and 0 distinct
    // keys over 0 rows is no fault. The two have to agree, or the check refuses
    // what the load then accepts.
    const resource = await withColumns('key-check-empty-pkg', ['id'], {
      rowCount: 0,
      distinctCount: 0,
    })

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['id'] }),
    })

    expect(await res.json()).toMatchObject({ checked: true, fault: null })
  })

  it('says it could not check rather than refusing, when there is no preview', async () => {
    // A composite key has to be read out of the content, and a revert clears the
    // preview until the rebuild lands. The apply asks nothing of the content, so
    // answering 400 here would block an operation the server accepts — the
    // screen has to be able to tell "will not work" from "cannot be told".
    const resource = await withColumns('key-check-no-preview-pkg', ['id', 'line'])

    const res = await app.request(`/api/v1/resources/${resource.id}/column-settings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['id', 'line'] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ checked: false, reason: 'no-preview' })
  })

  it('returns 401 for unauthenticated users', async () => {
    const resource = await withColumns('key-unauth-pkg', ['id'])

    const res = await unauthApp.request(`/api/v1/resources/${resource.id}/column-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryKey: ['id'] }),
    })

    expect(res.status).toBe(401)
  })

  it('does not read the settings out to an unauthenticated caller', async () => {
    // The read goes with the writes, not with the resource: it is the settings
    // screen's, and a public resource's version list already says what each
    // version was read under.
    const resource = await withColumns('key-read-unauth-pkg', ['id'])

    const res = await unauthApp.request(`/api/v1/resources/${resource.id}/column-settings`)

    expect(res.status).toBe(401)
  })
})
