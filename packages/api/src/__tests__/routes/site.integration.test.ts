import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp, mockSearch, mockCompletionAi } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { resetBootstrapCache } from '../../services/bootstrap'
import type { AIAdapter } from '@kukan/ai-adapter'

const db = getTestDb()

const embedAi = {
  getEmbeddingInfo: () => ({ model: 'stub-model', dimensions: 3 }),
  getCompletionInfo: () => null,
  embed: async () => [1, 0, 0],
} as unknown as AIAdapter

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

describe('GET /api/v1/site/settings', () => {
  it('should be public and report semantic search off without embedding support', async () => {
    // Default test AI is NoOp → the capability is absent regardless of the setting
    const res = await createTestApp(db, { user: null }).request('/api/v1/site/settings')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.semanticSearchEnabled).toBe(false)
    expect(body.searchExampleQueries).toEqual([])
  })

  it('should report semantic search on with embedding support and reflect the kill switch', async () => {
    const app = createTestApp(db, { search: mockSearch, ai: embedAi })

    let res = await app.request('/api/v1/site/settings')
    expect((await res.json()).semanticSearchEnabled).toBe(true)

    // Admin turns semantic search off site-wide
    const put = await app.request('/api/v1/admin/settings/semantic-search-enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    })
    expect(put.status).toBe(200)

    res = await app.request('/api/v1/site/settings')
    expect((await res.json()).semanticSearchEnabled).toBe(false)
  })

  it('should serve the admin-managed example queries', async () => {
    const app = createTestApp(db, { search: mockSearch, ai: embedAi })
    await app.request('/api/v1/admin/settings/search-example-queries', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: ['避難所の場所'] }),
    })

    const res = await app.request('/api/v1/site/settings')
    expect((await res.json()).searchExampleQueries).toEqual(['避難所の場所'])
  })

  it('should report metadata suggestions off without completion support', async () => {
    const res = await createTestApp(db, { user: null }).request('/api/v1/site/settings')
    expect((await res.json()).metadataSuggestEnabled).toBe(false)
  })

  it('should report metadata suggestions on with completion support and reflect the kill switch', async () => {
    const app = createTestApp(db, { search: mockSearch, ai: mockCompletionAi() })

    let res = await app.request('/api/v1/site/settings')
    expect((await res.json()).metadataSuggestEnabled).toBe(true)

    const put = await app.request('/api/v1/admin/settings/ai-suggest-enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    })
    expect(put.status).toBe(200)

    res = await app.request('/api/v1/site/settings')
    expect((await res.json()).metadataSuggestEnabled).toBe(false)
  })

  it('should reflect the registration-enabled runtime setting', async () => {
    const app = createTestApp(db)

    let res = await app.request('/api/v1/site/settings')
    expect((await res.json()).registrationEnabled).toBe(false)

    const put = await app.request('/api/v1/admin/settings/registration-enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: true }),
    })
    expect(put.status).toBe(200)

    res = await app.request('/api/v1/site/settings')
    expect((await res.json()).registrationEnabled).toBe(true)
  })

  it('should force registration on while no users exist (bootstrap, ADR-038)', async () => {
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`)
    resetBootstrapCache()

    const res = await createTestApp(db, { user: null }).request('/api/v1/site/settings')
    expect((await res.json()).registrationEnabled).toBe(true)
  })

  it('should cache publicly for anonymous requests only', async () => {
    const anonymous = await createTestApp(db, { user: null }).request('/api/v1/site/settings')
    expect(anonymous.headers.get('Cache-Control')).toContain('public')

    // Signed-in users must see their own changes immediately. The test app has
    // no global cacheControl default, so publicCache skipping = no header at all
    const authed = await createTestApp(db, {}).request('/api/v1/site/settings')
    expect(authed.headers.get('Cache-Control') ?? '').not.toContain('public')
  })
})
