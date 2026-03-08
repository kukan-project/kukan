import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Packages API Routes', () => {
  describe('GET /api/v1/packages', () => {
    it('should return 200 with empty list', async () => {
      const res = await app.request('/api/v1/packages')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should return paginated list after creating packages', async () => {
      // Create two packages
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-one' }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pkg-two' }),
      })

      const res = await app.request('/api/v1/packages')
      const body = await res.json()
      expect(body.total).toBe(2)
      expect(body.items).toHaveLength(2)
    })

    it('should filter by q parameter', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'population-data', title: 'Population Statistics' }),
      })
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'weather-data' }),
      })

      const res = await app.request('/api/v1/packages?q=population')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].name).toBe('population-data')
    })
  })

  describe('POST /api/v1/packages', () => {
    it('should create package and return 201', async () => {
      const res = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'new-dataset',
          title: 'New Dataset',
          notes: 'A test dataset',
        }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('new-dataset')
      expect(body.title).toBe('New Dataset')
      expect(body.state).toBe('active')
      expect(body.id).toBeDefined()
    })

    it('should reject invalid name with 400', async () => {
      const res = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A' }),
      })
      expect(res.status).toBe(400)
    })

    it('should reject duplicate name with 400', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'duplicate-pkg' }),
      })

      const res = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'duplicate-pkg' }),
      })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toContain('already exists')
    })
  })

  describe('GET /api/v1/packages/:nameOrId', () => {
    it('should return package by name', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'by-name-test' }),
      })

      const res = await app.request('/api/v1/packages/by-name-test')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.name).toBe('by-name-test')
    })

    it('should return package by UUID', async () => {
      const createRes = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'by-uuid-test' }),
      })
      const created = await createRes.json()

      const res = await app.request(`/api/v1/packages/${created.id}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.id).toBe(created.id)
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/v1/packages/does-not-exist')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/v1/packages/:nameOrId', () => {
    it('should update package', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-test', title: 'Original' }),
      })

      const res = await app.request('/api/v1/packages/update-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'update-test', title: 'Updated' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
    })
  })

  describe('PATCH /api/v1/packages/:nameOrId', () => {
    it('should partially update package', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'patch-test', title: 'Original', notes: 'Keep this' }),
      })

      const res = await app.request('/api/v1/packages/patch-test', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Patched' }),
      })
      expect(res.status).toBe(200)

      // Verify notes was preserved
      const getRes = await app.request('/api/v1/packages/patch-test')
      const body = await getRes.json()
      expect(body.title).toBe('Patched')
      expect(body.notes).toBe('Keep this')
    })
  })

  describe('DELETE /api/v1/packages/:nameOrId', () => {
    it('should soft delete package', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'delete-test' }),
      })

      const res = await app.request('/api/v1/packages/delete-test', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.state).toBe('deleted')
    })

    it('should not appear in list after deletion', async () => {
      await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'will-delete' }),
      })

      await app.request('/api/v1/packages/will-delete', { method: 'DELETE' })

      const listRes = await app.request('/api/v1/packages')
      const body = await listRes.json()
      expect(body.total).toBe(0)
    })

    it('should return 404 for non-existent package', async () => {
      const res = await app.request('/api/v1/packages/no-such-pkg', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/packages/:id/resources', () => {
    it('should list resources for a package', async () => {
      const createRes = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'res-list-test' }),
      })
      const pkg = await createRes.json()

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual([])
    })
  })

  describe('POST /api/v1/packages/:id/resources', () => {
    it('should create resource for package', async () => {
      const createRes = await app.request('/api/v1/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'res-create-test' }),
      })
      const pkg = await createRes.json()

      const res = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-resource', format: 'CSV' }),
      })
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.name).toBe('test-resource')
      expect(body.position).toBe(0)
    })
  })
})
