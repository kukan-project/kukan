import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp, mockCompletionAi } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'

const db = getTestDb()

const mockSearch: SearchAdapter = {
  indexPackage: async () => {},
  deletePackage: async () => {},
  bulkIndexPackages: vi.fn().mockResolvedValue(undefined),
  deleteAllPackages: vi.fn().mockResolvedValue(undefined),
  indexResource: async () => {},
  deleteResource: async () => {},
  bulkIndexResources: async () => {},
  deleteAllResources: async () => {},
  search: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  sumResourceCount: async () => 0,
  getIndexStats: async () => ({
    indexName: 'kukan-test',
    totalSizeBytes: 0,
    packages: { docCount: 0, sizeBytes: 0, recentDocs: [] },
    resources: { docCount: 0, sizeBytes: 0, recentDocs: [] },
    contents: { docCount: 0, sizeBytes: 0, recentDocs: [] },
  }),
  indexContent: async () => {},
  deleteContent: async () => {},
  deleteAllContents: async () => {},
  getDocument: async () => null,
  browseDocuments: async () => null,
  getContentChunks: async () => [],
  browseContentsByResource: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
  fetchContentHighlights: async () => ({}),
}

const app = createTestApp(db, { search: mockSearch })
const unauthApp = createTestApp(db, { user: null, search: mockSearch })
const nonAdminApp = createTestApp(db, {
  user: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'regular@example.com',
    name: 'regular-user',
    sysadmin: false,
  },
  search: mockSearch,
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
})

afterAll(async () => {
  await closeTestDb()
})

/** Create org and return its ID */
async function ensureOrg(name: string): Promise<string> {
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title: name }),
  })
  const org = await res.json()
  return org.id
}

describe('Admin API Routes', () => {
  describe('POST /api/v1/admin/reindex-metadata', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should enqueue reindex job via SQS', async () => {
      const res = await app.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.queued).toBe(true)
    })

    it('should return 400 when OpenSearch is not enabled', async () => {
      const pgSearch: SearchAdapter = { ...mockSearch, getIndexStats: async () => null }
      const pgApp = createTestApp(db, { search: pgSearch })

      const res = await pgApp.request('/api/v1/admin/reindex-metadata', { method: 'POST' })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toBe('OpenSearch not enabled')
    })
  })

  describe('POST /api/v1/admin/jobs/enqueue-all', () => {
    it('should stop the rows claiming the index it just emptied', async () => {
      // The runs this enqueues rebuild the content it deletes — left claiming
      // to be indexed, every one of them is a run with nothing to do
      const orgId = await ensureOrg('enqueue-all-org')
      const pkg = await (
        await app.request('/api/v1/packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'enqueue-all-pkg', ownerOrg: orgId }),
        })
      ).json()
      const res = await (
        await app.request(`/api/v1/packages/${pkg.id}/resources`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/data.csv', format: 'CSV' }),
        })
      ).json()
      await db.execute(
        sql`UPDATE resource_pipeline SET metadata = '{"contentIndexed": true}'::jsonb
            WHERE resource_id = ${res.id}`
      )

      expect((await app.request('/api/v1/admin/jobs/enqueue-all', { method: 'POST' })).status).toBe(
        200
      )

      const [row] = (
        await db.execute(
          sql`SELECT metadata ->> 'contentIndexed' AS indexed FROM resource_pipeline
              WHERE resource_id = ${res.id}`
        )
      ).rows
      expect(row).toEqual({ indexed: 'false' })
    })
  })

  describe('/api/v1/admin/settings/vector-search', () => {
    const SETTINGS_PATH = '/api/v1/admin/settings/vector-search'
    const embedAi = {
      getEmbeddingInfo: () => ({
        model: 'stub-model',
        dimensions: 3,
        recommendedMinSimilarity: 0.3,
      }),
      embed: async () => [1, 0, 0],
    } as unknown as AIAdapter

    it('should reject unauthenticated and non-sysadmin requests', async () => {
      expect((await unauthApp.request(SETTINGS_PATH)).status).toBe(401)
      expect((await nonAdminApp.request(SETTINGS_PATH)).status).toBe(403)
    })

    it('should report disabled state without embedding support', async () => {
      const res = await app.request(SETTINGS_PATH)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.enabled).toBe(false)
      expect(body.model).toBeNull()
      expect(body.baseSource).toBe('default')
      expect(body.baseMinSimilarity).toBe(0.45)
      expect(body.notches).toBe(0)
      expect(body.semanticEnabled).toBe(true)
    })

    it('should report the model recommendation as the base', async () => {
      const embedApp = createTestApp(db, { search: mockSearch, ai: embedAi })
      const res = await embedApp.request(SETTINGS_PATH)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toMatchObject({
        enabled: true,
        model: 'stub-model@3',
        semanticEnabled: true,
        baseSource: 'model',
        baseMinSimilarity: 0.3,
        notches: 0,
        step: 0.025,
        maxNotches: 4,
        effectiveMinSimilarity: 0.3,
      })
    })

    it('should apply generic writes to the effective value and audit them', async () => {
      const embedApp = createTestApp(db, { search: mockSearch, ai: embedAi })
      const put = (key: string, value: unknown) =>
        embedApp.request(`/api/v1/admin/settings/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        })

      let res = await put('vector-similarity-notches', -4)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ key: 'vector-similarity-notches', value: -4 })

      res = await put('semantic-search-enabled', false)
      expect(res.status).toBe(200)

      // The context endpoint reflects both writes
      const context = await (await embedApp.request(SETTINGS_PATH)).json()
      expect(context.notches).toBe(-4)
      expect(context.effectiveMinSimilarity).toBe(0.2)
      expect(context.semanticEnabled).toBe(false)

      const audit = await db.execute(
        sql`SELECT action, changes FROM audit_log WHERE entity_type = 'system_setting' ORDER BY id`
      )
      expect(audit.rows).toHaveLength(2)
      expect(audit.rows[0]).toMatchObject({
        action: 'update',
        changes: { key: 'vector-similarity-notches', value: -4, previous: null },
      })
      expect(audit.rows[1]).toMatchObject({
        changes: { key: 'semantic-search-enabled', value: false, previous: null },
      })

      // Upsert records the previous value
      await put('vector-similarity-notches', 2)
      const upsertAudit = await db.execute(
        sql`SELECT changes FROM audit_log WHERE entity_type = 'system_setting' ORDER BY id`
      )
      expect((upsertAudit.rows[2] as { changes: { previous: number } }).changes.previous).toBe(-4)
    })
  })

  describe('/api/v1/admin/settings/ai-suggest', () => {
    const AI_SUGGEST_PATH = '/api/v1/admin/settings/ai-suggest'

    it('should reject unauthenticated and non-sysadmin requests', async () => {
      expect((await unauthApp.request(AI_SUGGEST_PATH)).status).toBe(401)
      expect((await nonAdminApp.request(AI_SUGGEST_PATH)).status).toBe(403)
      const post = { method: 'POST' }
      expect((await unauthApp.request(`${AI_SUGGEST_PATH}/test`, post)).status).toBe(401)
      expect((await nonAdminApp.request(`${AI_SUGGEST_PATH}/test`, post)).status).toBe(403)
    })

    it('should report disabled state without completion support', async () => {
      const res = await app.request(AI_SUGGEST_PATH)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        enabled: false,
        provider: null,
        defaultModel: null,
        model: '',
        effectiveModel: null,
        suggestEnabled: true,
        availableModels: [],
      })
    })

    it('should resolve the effective model from setting > provider default', async () => {
      const aiApp = createTestApp(db, {
        search: mockSearch,
        ai: mockCompletionAi(),
      })

      let body = await (await aiApp.request(AI_SUGGEST_PATH)).json()
      expect(body).toEqual({
        enabled: true,
        provider: 'ollama',
        defaultModel: 'gemma4:e4b',
        model: '',
        effectiveModel: 'gemma4:e4b',
        suggestEnabled: true,
        availableModels: ['gemma4:e4b', 'qwen3:8b'],
      })

      const res = await aiApp.request('/api/v1/admin/settings/ai-suggest-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'qwen3:8b' }),
      })
      expect(res.status).toBe(200)

      body = await (await aiApp.request(AI_SUGGEST_PATH)).json()
      expect(body.model).toBe('qwen3:8b')
      expect(body.effectiveModel).toBe('qwen3:8b')
    })

    it('should reflect the kill switch in the context', async () => {
      const aiApp = createTestApp(db, { search: mockSearch, ai: mockCompletionAi() })

      const res = await aiApp.request('/api/v1/admin/settings/ai-suggest-enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: false }),
      })
      expect(res.status).toBe(200)

      const body = await (await aiApp.request(AI_SUGGEST_PATH)).json()
      // Capability stays true — the switch disables the feature, not the adapter
      expect(body.enabled).toBe(true)
      expect(body.suggestEnabled).toBe(false)
    })

    it('falls back to an empty model list when enumeration fails', async () => {
      const ai = {
        ...mockCompletionAi(),
        listCompletionModels: async () => {
          throw new Error('provider unreachable')
        },
      }
      const aiApp = createTestApp(db, { search: mockSearch, ai })

      const res = await aiApp.request(AI_SUGGEST_PATH)
      expect(res.status).toBe(200)
      expect((await res.json()).availableModels).toEqual([])
    })

    it('POST /test should return 400 when completion is unavailable', async () => {
      const res = await app.request(`${AI_SUGGEST_PATH}/test`, { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('POST /test should report success with model and latency', async () => {
      const complete = vi.fn().mockResolvedValue('{"ok":true}')
      const aiApp = createTestApp(db, { search: mockSearch, ai: mockCompletionAi(complete) })

      const res = await aiApp.request(`${AI_SUGGEST_PATH}/test`, { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.model).toBe('gemma4:e4b')
      expect(typeof body.latencyMs).toBe('number')
      // Effective model, JSON forcing, and a bounded timeout all reach the adapter
      const options = complete.mock.calls[0][1]
      expect(options).toMatchObject({ model: 'gemma4:e4b' })
      expect(options.jsonSchema?.schema).toMatchObject({ type: 'object' })
      expect(options.timeoutMs).toBeGreaterThan(0)
    })

    it('POST /test rejects a resolving-but-invalid response (schema ignored)', async () => {
      // An endpoint that ignores structured output returns prose, not JSON
      const aiApp = createTestApp(db, {
        search: mockSearch,
        ai: mockCompletionAi(async () => 'Sure, ok!'),
      })

      const res = await aiApp.request(`${AI_SUGGEST_PATH}/test`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/JSON|schema/i)
    })

    it('POST /test should surface failures as ok:false with the message', async () => {
      const aiApp = createTestApp(db, {
        search: mockSearch,
        ai: mockCompletionAi(async () => {
          throw new Error('Ollama chat failed: 404 model not found')
        }),
      })

      const res = await aiApp.request(`${AI_SUGGEST_PATH}/test`, { method: 'POST' })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toContain('model not found')
    })
  })

  describe('/api/v1/admin/settings (generic)', () => {
    const put = (key: string, value: unknown) =>
      app.request(`/api/v1/admin/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })

    it('should list every registered setting with its current value', async () => {
      const res = await app.request('/api/v1/admin/settings')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        'vector-similarity-notches': 0,
        'semantic-search-enabled': true,
        'search-example-queries': [],
        'registration-enabled': false,
        'ai-suggest-model': '',
        'ai-suggest-enabled': true,
      })
    })

    it('should persist example queries (trimmed) and audit the change', async () => {
      let res = await put('search-example-queries', ['避難所の場所', ' 無料Wi-Fi '])
      expect(res.status).toBe(200)
      expect((await res.json()).value).toEqual(['避難所の場所', '無料Wi-Fi'])

      const audit = await db.execute(
        sql`SELECT changes FROM audit_log WHERE entity_type = 'system_setting'`
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]).toMatchObject({
        changes: { key: 'search-example-queries', previous: null },
      })

      // An empty list hides the chips again
      res = await put('search-example-queries', [])
      expect((await res.json()).value).toEqual([])
    })

    it('should reject values that fail the registry schema', async () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `q${i}`)
      for (const [key, value] of [
        ['search-example-queries', eleven],
        ['search-example-queries', ['x'.repeat(101)]],
        ['search-example-queries', ['']],
        ['search-example-queries', 'not-an-array'],
        ['search-example-queries', null],
        ['vector-similarity-notches', 5],
        ['vector-similarity-notches', 0.5],
        ['semantic-search-enabled', 'yes'],
      ] as Array<[string, unknown]>) {
        const res = await put(key, value)
        expect(res.status).toBe(400)
      }
    })

    it('should return 404 for unknown setting keys', async () => {
      for (const key of ['nope', 'vector-search']) {
        const res = await put(key, 1)
        expect(res.status).toBe(404)
      }
    })

    it('should reject unauthenticated and non-sysadmin requests', async () => {
      expect((await unauthApp.request('/api/v1/admin/settings')).status).toBe(401)
      expect((await nonAdminApp.request('/api/v1/admin/settings')).status).toBe(403)
    })
  })

  describe('GET /api/v1/admin/search/stats', () => {
    it('should return index stats with DB counts', async () => {
      const res = await app.request('/api/v1/admin/search/stats')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.enabled).toBe(true)
      expect(body.db).toBeDefined()
      expect(typeof body.db.packages).toBe('number')
      expect(typeof body.db.resources).toBe('number')
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/search/stats')
      expect(res.status).toBe(403)
    })

    it('should not count draft packages or their resources in DB counts (ADR-039)', async () => {
      const orgId = await ensureOrg('stats-org')
      const activePkg = await db.execute(sql`
        INSERT INTO package (name, owner_org, state) VALUES ('stats-active', ${orgId}, 'active')
        RETURNING id
      `)
      const draftPkg = await db.execute(sql`
        INSERT INTO package (name, owner_org, state) VALUES ('stats-draft', ${orgId}, 'draft')
        RETURNING id
      `)
      await db.execute(sql`
        INSERT INTO resource (package_id, name, state)
        VALUES (${(activePkg.rows[0] as { id: string }).id}, 'active-res', 'active'),
               (${(draftPkg.rows[0] as { id: string }).id}, 'draft-res', 'active')
      `)

      const res = await app.request('/api/v1/admin/search/stats')
      const body = await res.json()
      expect(body.db.packages).toBe(1)
      expect(body.db.resources).toBe(1)
    })
  })

  describe('POST /api/v1/admin/users/:userId/restore', () => {
    /** Create a test user with a unique name to avoid constraint conflicts across runs */
    function uniqueName(prefix: string) {
      return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users/fake-id/restore', { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users/fake-id/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('should prevent self-restore', async () => {
      const res = await app.request(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/restore',
        { method: 'POST' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('yourself')
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/non-existent-id/restore', {
        method: 'POST',
      })
      expect(res.status).toBe(404)
    })

    it('should reject restore of active user', async () => {
      const name = uniqueName('active-restore')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'active', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/restore`, { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('soft-deleted')
    })

    it('should restore a soft-deleted user', async () => {
      const name = uniqueName('to-restore')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'deleted', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/restore`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      const check = await db.execute(sql`SELECT state FROM "user" WHERE id = ${userId}`)
      expect((check.rows[0] as { state: string }).state).toBe('active')
    })
  })

  describe('POST /api/v1/admin/users/:userId/purge', () => {
    function uniqueName(prefix: string) {
      return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }

    async function createAndDeleteUser(prefix: string) {
      const name = uniqueName(prefix)
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'deleted', 'user', NOW(), NOW())
            RETURNING id`
      )
      return (result.rows[0] as { id: string }).id
    }

    it('should reject unauthenticated requests', async () => {
      const res = await unauthApp.request('/api/v1/admin/users/fake-id/purge', { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/users/fake-id/purge', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/api/v1/admin/users/non-existent-id/purge', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('should reject purge of active (non-deleted) user', async () => {
      const name = uniqueName('active-user')
      const result = await db.execute(
        sql`INSERT INTO "user" (id, name, email, "emailVerified", state, role, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${name}, ${name + '@example.com'}, false, 'active', 'user', NOW(), NOW())
            RETURNING id`
      )
      const userId = (result.rows[0] as { id: string }).id

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('soft-deleted')
    })

    it('should reject purge when user has linked packages', async () => {
      const orgId = await ensureOrg('purge-test-org')
      const userId = await createAndDeleteUser('pkg-linked')

      const pkgName = uniqueName('purge-test-pkg')
      await db.execute(
        sql`INSERT INTO package (name, state, creator_user_id, owner_org) VALUES (${pkgName}, 'active', ${userId}, ${orgId})`
      )

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.detail).toContain('linked packages')
    })

    it('should prevent self-purge', async () => {
      const res = await app.request(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/purge',
        { method: 'POST' }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('yourself')
    })

    it('should purge a soft-deleted user and nullify activity/audit references', async () => {
      const userId = await createAndDeleteUser('to-purge')

      // Insert activity and audit log for this user
      await db.execute(
        sql`INSERT INTO activity (object_id, object_type, activity_type, user_id) VALUES (gen_random_uuid(), 'test', 'test_action', ${userId})`
      )
      await db.execute(
        sql`INSERT INTO audit_log (entity_type, entity_id, action, user_id) VALUES ('test', ${userId}, 'test_action', ${userId})`
      )

      const res = await app.request(`/api/v1/admin/users/${userId}/purge`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      // Verify user is gone
      const userCheck = await db.execute(sql`SELECT id FROM "user" WHERE id = ${userId}`)
      expect(userCheck.rows).toHaveLength(0)

      // Verify activity/audit_log user_id is nullified
      const activityCheck = await db.execute(
        sql`SELECT user_id FROM activity WHERE object_type = 'test'`
      )
      for (const row of activityCheck.rows) {
        expect((row as { user_id: string | null }).user_id).toBeNull()
      }

      // Verify purge audit log was recorded with purgedUserId in changes
      const auditCheck = await db.execute(
        sql`SELECT changes FROM audit_log WHERE action = 'purge' AND entity_type = 'user'`
      )
      expect(auditCheck.rows).toHaveLength(1)
      const changes = (auditCheck.rows[0] as { changes: Record<string, unknown> }).changes
      expect(changes.purgedUserId).toBe(userId)
    })
  })
})
