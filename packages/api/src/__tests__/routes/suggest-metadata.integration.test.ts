import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createTestApp, mockSearch, mockCompletionAi } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  ensureOutsiderUser,
  OUTSIDER_USER_ID,
} from '../test-helpers/test-db'
import { suggestRateLimiter } from '../../services/suggest/rate-limit'
import { SUGGEST_RATE_LIMIT } from '../../config'

const db = getTestDb()

const VALID_OUTPUT = JSON.stringify({
  title: '提案タイトル',
  notes: '提案の説明文です。',
  tags: ['防災'],
  groups: [],
})

const OUTSIDER_USER = {
  id: OUTSIDER_USER_ID,
  email: 'outsider@example.com',
  name: 'outsider',
  sysadmin: false,
}

const json = (data: Record<string, unknown> = {}) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
})

const putSetting = (app: ReturnType<typeof createTestApp>, key: string, value: unknown) =>
  app.request(`/api/v1/admin/settings/${key}`, { ...json({ value }), method: 'PUT' })

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()
  suggestRateLimiter.reset()
})

afterAll(async () => {
  await closeTestDb()
})

async function createPackage(app: ReturnType<typeof createTestApp>, name: string) {
  const orgRes = await app.request('/api/v1/organizations', json({ name: `org-${name}` }))
  const org = await orgRes.json()
  const pkgRes = await app.request(
    '/api/v1/packages',
    json({ name, ownerOrg: org.id, title: '元タイトル', tags: [{ name: '既存タグ' }] })
  )
  expect(pkgRes.status).toBe(201)
  return pkgRes.json()
}

describe('POST /api/v1/packages/:nameOrId/suggest-metadata', () => {
  it('should reject unauthenticated requests', async () => {
    const app = createTestApp(db, { search: mockSearch, user: null, ai: mockCompletionAi() })
    const res = await app.request('/api/v1/packages/some-pkg/suggest-metadata', json())
    expect(res.status).toBe(401)
  })

  it('should return 503 when the AI adapter cannot generate (NoOp)', async () => {
    const app = createTestApp(db, { search: mockSearch })
    await createPackage(app, 'noop-pkg')
    const res = await app.request('/api/v1/packages/noop-pkg/suggest-metadata', json())
    expect(res.status).toBe(503)
  })

  it('should return 503 when the kill switch is off', async () => {
    const app = createTestApp(db, { search: mockSearch, ai: mockCompletionAi() })
    await createPackage(app, 'killed-pkg')
    await putSetting(app, 'ai-suggest-enabled', false)

    const res = await app.request('/api/v1/packages/killed-pkg/suggest-metadata', json())
    expect(res.status).toBe(503)
  })

  it('should reject editors without org access', async () => {
    const ai = mockCompletionAi()
    const app = createTestApp(db, { search: mockSearch, ai })
    const outsiderApp = createTestApp(db, { search: mockSearch, ai, user: OUTSIDER_USER })
    await createPackage(app, 'protected-pkg')

    const res = await outsiderApp.request('/api/v1/packages/protected-pkg/suggest-metadata', json())
    expect(res.status).toBe(403)
  })

  it('should let a draft creator request suggestions (ADR-039 creator rule)', async () => {
    const outsiderApp = createTestApp(db, {
      search: mockSearch,
      ai: mockCompletionAi(async () => VALID_OUTPUT),
      user: OUTSIDER_USER,
    })
    const draftRes = await outsiderApp.request('/api/v1/packages/drafts', json({}))
    const draft = await draftRes.json()

    const res = await outsiderApp.request(`/api/v1/packages/${draft.id}/suggest-metadata`, json())
    expect(res.status).toBe(200)
    expect((await res.json()).suggestion.title).toBe('提案タイトル')
  })

  it('should return the post-processed suggestion with provenance', async () => {
    const complete = vi.fn().mockResolvedValue(VALID_OUTPUT)
    const app = createTestApp(db, { search: mockSearch, ai: mockCompletionAi(complete) })
    await createPackage(app, 'suggest-pkg')

    const res = await app.request(
      '/api/v1/packages/suggest-pkg/suggest-metadata',
      json({ locale: 'ja' })
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.suggestion).toEqual({
      title: '提案タイトル',
      notes: '提案の説明文です。',
      // The package's own tag is kept; 防災 is not among the site's tags,
      // so it is marked new
      tags: [
        { name: '既存タグ', isNew: false },
        { name: '防災', isNew: true },
      ],
      groups: [],
      resources: [],
    })
    expect(body.generatedBy).toEqual({ provider: 'ollama', model: 'gemma4:e4b' })
    // Default model resolution and Japanese generation reach the adapter
    const options = complete.mock.calls[0][1]
    expect(options.model).toBe('gemma4:e4b')
    expect(options.system).toContain('Japanese')
  })

  it('should use the runtime model setting when set', async () => {
    const complete = vi.fn().mockResolvedValue(VALID_OUTPUT)
    const app = createTestApp(db, { search: mockSearch, ai: mockCompletionAi(complete) })
    await createPackage(app, 'model-pkg')
    await putSetting(app, 'ai-suggest-model', 'qwen3:8b')

    const res = await app.request('/api/v1/packages/model-pkg/suggest-metadata', json())
    expect(res.status).toBe(200)
    expect((await res.json()).generatedBy.model).toBe('qwen3:8b')
    expect(complete.mock.calls[0][1].model).toBe('qwen3:8b')
  })

  it('should rate-limit per user with 429', async () => {
    const app = createTestApp(db, {
      search: mockSearch,
      ai: mockCompletionAi(async () => VALID_OUTPUT),
    })
    await createPackage(app, 'limited-pkg')

    for (let i = 0; i < SUGGEST_RATE_LIMIT; i++) {
      const res = await app.request('/api/v1/packages/limited-pkg/suggest-metadata', json())
      expect(res.status).toBe(200)
    }
    const res = await app.request('/api/v1/packages/limited-pkg/suggest-metadata', json())
    expect(res.status).toBe(429)
  })

  it('should return 404 for unknown packages', async () => {
    const app = createTestApp(db, { search: mockSearch, ai: mockCompletionAi() })
    const res = await app.request('/api/v1/packages/no-such-pkg/suggest-metadata', json())
    expect(res.status).toBe(404)
  })
})
