import { describe, it, expect, afterAll } from 'vitest'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const app = createTestApp(db)

afterAll(async () => {
  await closeTestDb()
})

describe('Health check', () => {
  it('GET /api/health should return status ok', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.timestamp).toBeDefined()
  })
})

describe('404 handler', () => {
  it('should return RFC 7807 for unknown routes', async () => {
    const res = await app.request('/api/v1/nonexistent')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body.type).toBe('about:blank')
    expect(body.title).toBe('NOT_FOUND')
    expect(body.status).toBe(404)
  })
})
