import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)
const unauthApp = createTestApp(db, { user: null })

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
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

async function createPackage(name: string) {
  const orgId = await ensureTestOrg()
  const res = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, owner_org: orgId }),
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
  })

  describe('DELETE /api/v1/resources/:id', () => {
    it('should soft delete resource', async () => {
      const pkg = await createPackage('delete-res-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.state).toBe('deleted')
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

  // --- Upload flow ---

  describe('POST /api/v1/resources/:id/upload-url', () => {
    it('should return presigned upload URL', async () => {
      const pkg = await createPackage('upload-url-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
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
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
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
          content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
      })
      expect(res.status).toBe(403)
    })

    it('should reject invalid input (missing filename)', async () => {
      const pkg = await createPackage('upload-url-invalid-pkg')
      const resource = await createResource(pkg.id)

      const res = await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_type: 'text/csv' }),
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
      expect(res.status).toBe(403)
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
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
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
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
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
      expect(res.status).toBe(403)
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
        body: JSON.stringify({ filename: 'data.csv', content_type: 'text/csv' }),
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
    })
  })

  describe('GET /api/v1/resources/:id/download-url', () => {
    it('should return external URL for non-upload resource', async () => {
      const pkg = await createPackage('dl-url-ext-pkg')
      const resource = await createResource(pkg.id, {
        url: 'https://example.com/data.csv',
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/download-url`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.url).toBe('https://example.com/data.csv')
    })

    it('should return presigned URL for upload resource', async () => {
      const pkg = await createPackage('dl-url-upload-pkg')
      const resource = await createResource(pkg.id)

      // Prepare as upload
      await app.request(`/api/v1/resources/${resource.id}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'report.pdf', content_type: 'application/pdf' }),
      })

      const res = await app.request(`/api/v1/resources/${resource.id}/download-url`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.url).toBeDefined()
      expect(typeof body.url).toBe('string')
    })

    it('should return 404 for non-existent resource', async () => {
      const res = await app.request(
        '/api/v1/resources/550e8400-e29b-41d4-a716-446655440000/download-url'
      )
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
})
