import { describe, it, expect, vi, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, closeTestDb } from '../test-helpers/test-db'
import type { AnalyticsService } from '../../services/analytics-service'

const db = getTestDb()

const mockAnalytics = {
  getDatasetViews: vi.fn().mockResolvedValue({
    items: [{ label: 'my-dataset', value: 100, href: '/dataset/my-dataset' }],
    total: 1,
  }),
  getResourceViews: vi.fn().mockResolvedValue({
    items: [{ label: 'ds / res-1', value: 50, href: '/dataset/ds/resource/res-1' }],
    total: 1,
  }),
  getDownloads: vi.fn().mockResolvedValue({
    items: [{ label: 'ds / res-1 (CSV)', value: 10 }],
    total: 1,
  }),
  getSearchTerms: vi.fn().mockResolvedValue({
    items: [{ label: 'open data', value: 25, href: '/dataset?q=open%20data' }],
    total: 1,
  }),
} as unknown as AnalyticsService

const app = createTestApp(db, { analytics: mockAnalytics })
const unauthApp = createTestApp(db, { user: null })
const nonAdminApp = createTestApp(db, {
  user: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'regular@example.com',
    name: 'regular-user',
    sysadmin: false,
  },
})
const unconfiguredApp = createTestApp(db, { analytics: null })

afterAll(async () => {
  await closeTestDb()
})

const ENDPOINTS = [
  '/api/v1/admin/analytics/dataset-views',
  '/api/v1/admin/analytics/resource-views',
  '/api/v1/admin/analytics/downloads',
  '/api/v1/admin/analytics/search-terms',
] as const

describe('Admin Analytics API Routes', () => {
  describe('authentication and authorization', () => {
    it.each(ENDPOINTS)('should reject unauthenticated requests to %s', async (url) => {
      const res = await unauthApp.request(url)
      expect(res.status).toBe(401)
    })

    it.each(ENDPOINTS)('should reject non-sysadmin requests to %s', async (url) => {
      const res = await nonAdminApp.request(url)
      expect(res.status).toBe(403)
    })
  })

  describe('when GA4 is not configured', () => {
    it.each(ENDPOINTS)('should return 404 with guidance for %s', async (url) => {
      const res = await unconfiguredApp.request(url)
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.detail).toContain('GA4 analytics is not configured')
    })
  })

  describe('GET /api/v1/admin/analytics/dataset-views', () => {
    it('should return paginated dataset views', async () => {
      const res = await app.request(
        '/api/v1/admin/analytics/dataset-views?startDate=30daysAgo&endDate=today'
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].label).toBe('my-dataset')
      expect(body.total).toBe(1)
      expect(body.offset).toBe(0)
      expect(body.limit).toBe(20)
    })

    it('should pass query params to service', async () => {
      await app.request(
        '/api/v1/admin/analytics/dataset-views?startDate=7daysAgo&endDate=today&offset=10&limit=5'
      )
      expect(mockAnalytics.getDatasetViews).toHaveBeenCalledWith('7daysAgo', 'today', 10, 5)
    })

    it('should default to 30daysAgo/today when dates not specified', async () => {
      await app.request('/api/v1/admin/analytics/dataset-views')
      expect(mockAnalytics.getDatasetViews).toHaveBeenCalledWith('30daysAgo', 'today', 0, 20)
    })
  })

  describe('GET /api/v1/admin/analytics/resource-views', () => {
    it('should return resource views', async () => {
      const res = await app.request('/api/v1/admin/analytics/resource-views')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].label).toBe('ds / res-1')
    })
  })

  describe('GET /api/v1/admin/analytics/downloads', () => {
    it('should return download counts', async () => {
      const res = await app.request('/api/v1/admin/analytics/downloads')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].label).toBe('ds / res-1 (CSV)')
    })
  })

  describe('GET /api/v1/admin/analytics/search-terms', () => {
    it('should return search terms', async () => {
      const res = await app.request('/api/v1/admin/analytics/search-terms')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].label).toBe('open data')
    })
  })
})
