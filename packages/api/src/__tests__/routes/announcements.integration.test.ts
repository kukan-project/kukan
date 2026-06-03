import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

async function createAnnouncement(overrides?: Record<string, unknown>) {
  const res = await app.request(
    '/api/v1/announcements',
    json({ title: 'Test', category: 'info', ...overrides })
  )
  expect(res.status).toBe(201)
  return res.json()
}

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('Announcements API Routes', () => {
  describe('GET /api/v1/announcements', () => {
    it('should return empty list', async () => {
      const res = await app.request('/api/v1/announcements')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
    })

    it('should return only published announcements by default', async () => {
      // Published (past)
      await createAnnouncement({
        title: 'Published',
        publishedAt: '2020-01-01T00:00:00Z',
      })
      // Draft (no publishedAt)
      await createAnnouncement({ title: 'Draft' })
      // Scheduled (future)
      await createAnnouncement({
        title: 'Scheduled',
        publishedAt: '2099-01-01T00:00:00Z',
      })

      const res = await app.request('/api/v1/announcements')
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].title).toBe('Published')
    })

    it('should return all announcements with publishedOnly=false for sysadmin', async () => {
      await createAnnouncement({ title: 'Published', publishedAt: '2020-01-01T00:00:00Z' })
      await createAnnouncement({ title: 'Draft' })

      const res = await app.request('/api/v1/announcements?publishedOnly=false')
      const body = await res.json()
      expect(body.total).toBe(2)
    })

    it('should ignore publishedOnly=false for non-sysadmin', async () => {
      await createAnnouncement({ title: 'Published', publishedAt: '2020-01-01T00:00:00Z' })
      await createAnnouncement({ title: 'Draft' })

      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/announcements?publishedOnly=false')
      const body = await res.json()
      expect(body.total).toBe(1)
    })
  })

  describe('POST /api/v1/announcements', () => {
    it('should create and return 201', async () => {
      const res = await app.request(
        '/api/v1/announcements',
        json({ title: 'New', category: 'maintenance', link: 'https://example.com' })
      )
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.title).toBe('New')
      expect(body.category).toBe('maintenance')
      expect(body.link).toBe('https://example.com')
      expect(body.publishedAt).toBeNull()
    })

    it('should create with publishedAt', async () => {
      const res = await app.request(
        '/api/v1/announcements',
        json({ title: 'Scheduled', publishedAt: '2026-06-05T10:00:00Z' })
      )
      expect(res.status).toBe(201)

      const body = await res.json()
      expect(body.publishedAt).toBeTruthy()
    })

    it('should reject invalid category', async () => {
      const res = await app.request(
        '/api/v1/announcements',
        json({ title: 'Bad', category: 'invalid' })
      )
      expect(res.status).toBe(400)
    })

    it('should reject empty title', async () => {
      const res = await app.request('/api/v1/announcements', json({ title: '' }))
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/announcements/:id', () => {
    it('should return 400 for invalid UUID', async () => {
      const res = await app.request('/api/v1/announcements/not-a-uuid')
      expect(res.status).toBe(400)
    })

    it('should return published announcement', async () => {
      const created = await createAnnouncement({
        title: 'Visible',
        publishedAt: '2020-01-01T00:00:00Z',
      })

      const res = await app.request(`/api/v1/announcements/${created.id}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.title).toBe('Visible')
    })

    it('should return 404 for non-existent', async () => {
      const res = await app.request('/api/v1/announcements/00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(404)
    })

    it('should return 404 for draft when non-sysadmin', async () => {
      const created = await createAnnouncement({ title: 'Draft' })

      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request(`/api/v1/announcements/${created.id}`)
      expect(res.status).toBe(404)
    })

    it('should return draft for sysadmin', async () => {
      const created = await createAnnouncement({ title: 'Draft' })

      const res = await app.request(`/api/v1/announcements/${created.id}`)
      expect(res.status).toBe(200)
    })
  })

  describe('PUT /api/v1/announcements/:id', () => {
    it('should update announcement', async () => {
      const created = await createAnnouncement({ title: 'Original' })

      const res = await app.request(`/api/v1/announcements/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated', category: 'important' }),
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.title).toBe('Updated')
      expect(body.category).toBe('important')
    })
  })

  describe('DELETE /api/v1/announcements/:id', () => {
    it('should hard delete', async () => {
      const created = await createAnnouncement({ title: 'To Delete' })

      const res = await app.request(`/api/v1/announcements/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)

      const getRes = await app.request(`/api/v1/announcements/${created.id}`)
      expect(getRes.status).toBe(404)
    })
  })

  describe('Authorization', () => {
    it('should reject unauthenticated create', async () => {
      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request('/api/v1/announcements', json({ title: 'Nope' }))
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin create', async () => {
      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request('/api/v1/announcements', json({ title: 'Nope' }))
      expect(res.status).toBe(403)
    })

    it('should reject unauthenticated update', async () => {
      const created = await createAnnouncement({ title: 'Auth Test' })

      const noAuthApp = createTestApp(db, { user: null })
      const res = await noAuthApp.request(`/api/v1/announcements/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked' }),
      })
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin delete', async () => {
      const created = await createAnnouncement({ title: 'Auth Test' })

      const regularApp = createTestApp(db, {
        user: { id: 'regular', email: 'r@r.com', name: 'regular', sysadmin: false },
      })
      const res = await regularApp.request(`/api/v1/announcements/${created.id}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })
  })
})
