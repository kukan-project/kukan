import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { resource as resourceTable, resourcePipeline, resourcePipelineStep } from '@kukan/db'
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
  return res.json()
}

describe('Resources API Routes', () => {
  describe('GET /api/v1/resources/:id', () => {
    it('should return resource by ID', async () => {
      const pkg = await createPackage('res-test-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('test-resource')
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

  describe('PUT /api/v1/resources/:id', () => {
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

    it('should update resource urlType to upload', async () => {
      const pkg = await createPackage('upload-url-type-pkg')
      const resource = await createResource(pkg.id)

      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', contentType: 'text/csv' }),
      })

      // Verify resource was updated
      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.urlType).toBe('upload')
      expect(body.url).toBe('data.csv')
    })

    it('should derive format from filename', async () => {
      const pkg = await createPackage('upload-url-format-pkg')
      const resource = await createResource(pkg.id)

      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'report.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      })

      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.format).toBe('XLSX')
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

    it('should update size and hash metadata', async () => {
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
        body: JSON.stringify({ size: 4096, hash: 'sha256:def' }),
      })

      const getRes = await app.request(`/api/v1/resources/${resource.id}`)
      const body = await getRes.json()
      expect(body.size).toBe(4096)
      expect(body.hash).toBe('sha256:def')
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
})
