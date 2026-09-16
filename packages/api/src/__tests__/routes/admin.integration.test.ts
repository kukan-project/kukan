import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  packageTable,
  resource,
  resourcePipeline,
  resourcePipelineStep,
  resourceVersion,
} from '@kukan/db'
import { createTestApp, mockCompletionAi } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import { generationKey } from '@kukan/shared'

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

  describe('POST /api/v1/admin/reindex-embeddings', () => {
    /** Embedding available, which is what the endpoint gates on. */
    const embeddingAi = {
      getEmbeddingInfo: () => ({ model: 'test-model', dimension: 4 }),
    } as unknown as AIAdapter

    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/reindex-embeddings', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('queues the embed-all job, with or without OpenSearch', async () => {
      const pgSearch: SearchAdapter = { ...mockSearch, getIndexStats: async () => null }
      const embedApp = createTestApp(db, { search: pgSearch, ai: embeddingAi })

      const res = await embedApp.request('/api/v1/admin/reindex-embeddings', { method: 'POST' })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ queued: true })
    })

    it('returns 400 when embedding is not configured', async () => {
      const res = await app.request('/api/v1/admin/reindex-embeddings', { method: 'POST' })

      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('Embedding is not configured')
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
        'ai-summary-locale': 'ja',
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

  describe('resource abstracts (ADR-053)', () => {
    /** Generation available, which is what the endpoint gates on */
    const summaryApp = createTestApp(db, {
      search: mockSearch,
      ai: mockCompletionAi(),
      env: { AI_SUMMARY_MODEL: 'gemma4:e4b' },
    })

    it('refuses to start a generation on a site that has abstracts switched off', async () => {
      const res = await app.request('/api/v1/admin/generate-summaries', { method: 'POST' })
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toMatch(/not enabled/)
    })

    it('refuses a model the deployment never approved, rather than substituting one', async () => {
      // The provider default is whatever is first in the allow-list, and the
      // measurements say the wrong model there does not write worse abstracts
      // — it writes invented ones (ADR-053 appendix 18)
      const strayApp = createTestApp(db, {
        search: mockSearch,
        ai: mockCompletionAi(),
        env: { AI_SUMMARY_MODEL: 'some.model-nobody-granted' },
      })

      const res = await strayApp.request('/api/v1/admin/generate-summaries', { method: 'POST' })
      expect(res.status).toBe(400)
    })

    it('rejects non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/generate-summaries', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('queues the generation where they are enabled', async () => {
      const res = await summaryApp.request('/api/v1/admin/generate-summaries', { method: 'POST' })
      expect(res.status).toBe(200)
      expect((await res.json()).queued).toBe(true)
    })

    /**
     * Resources an abstract could actually be written for: an active version
     * holding the bytes the row points at (ADR-046), and the derivatives the
     * material is read from.
     *
     * Both are what the estimate joins on, so a fixture missing either stands
     * for a resource nothing would ever be generated for — which is what the
     * estimate used to quote money against.
     */
    async function insertReachable(
      values: (typeof resource.$inferInsert)[],
      /** Whether Index extracted any text — the only path left where no
       *  provider takes the original */
      opts: { textHead?: boolean } = {}
    ) {
      const rows = await db
        .insert(resource)
        .values(values.map((v, i) => ({ hash: `h-${i}-${v.name}`, ...v })))
        .returning({ id: resource.id, name: resource.name, hash: resource.hash })
      await db.insert(resourceVersion).values(
        rows.map((r) => ({
          resourceId: r.id,
          version: 1,
          storageKey: `k-${r.id}`,
          hash: r.hash!,
          origin: 'upload' as const,
          state: 'active' as const,
        }))
      )
      await db.insert(resourcePipeline).values(
        rows.map((r) => ({
          resourceId: r.id,
          status: 'complete',
          previewKey: `previews/${r.id}.parquet`,
          metadata: {
            schema: { columns: [], rowCount: 0 },
            ...(opts.textHead === false ? {} : { textHeadKey: `previews/${r.id}.txt` }),
          },
        }))
      )
      return rows
    }

    it('estimates by what each format would send, and spans what it cannot see', async () => {
      const orgId = await ensureOrg('estimate-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        // Material formats: no original goes, so size is irrelevant
        { packageId: pkg.id, name: 'a', format: 'CSV', size: 90_000_000, state: 'active' },
        // A PDF inside the byte limit
        { packageId: pkg.id, name: 'b', format: 'PDF', size: 1_000_000, state: 'active' },
      ])
      // Out of scope only because nothing was extracted: past the byte limit
      // the original cannot go, and with a text layer either of these would be
      // work rather than a refusal
      await insertReachable(
        [
          { packageId: pkg.id, name: 'c', format: 'PDF', size: 90_000_000, state: 'active' },
          // Nothing takes PPTX
          { packageId: pkg.id, name: 'd', format: 'PPTX', size: 1000, state: 'active' },
        ],
        { textHead: false }
      )

      const res = await summaryApp.request('/api/v1/admin/summary-estimate')
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.fill.resources).toBe(2)
      expect(body.skipped).toEqual({ tooLarge: 1, unsupportedFormat: 1, noMaterial: 0 })
      // The 78MB CSV costs what a 6KB one costs: its material is a schema and
      // five rows either way
      expect(body.fill.estimatedInputTokens.low).toBe(4_000)
      // And the PDF's span reaches the page limit, which is what nobody can
      // see from here
      expect(body.fill.estimatedInputTokens.high).toBe(2_000 + 50 * 2_500)
      expect(body.fill.estimatedOutputTokens).toBe(600)
      // Nothing is written yet, so a refresh would cover exactly the same
      expect(body.refresh.resources).toBe(2)
      // Priced from both token counts, at the rate recorded for this model —
      // output is a third of the bill on a catalogue of small files
      expect(body.model).toBe('gemma4:e4b')
      expect(body.fill.estimatedCostUsd).toBeNull()
    })

    it("leaves out what generation always skips: an editor's text, and a hidden one", async () => {
      const orgId = await ensureOrg('estimate-editor-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-editor-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        { packageId: pkg.id, name: 'a', format: 'CSV', size: 1000, state: 'active' },
        {
          packageId: pkg.id,
          name: 'b',
          format: 'CSV',
          size: 1000,
          state: 'active',
          summary: '人が書いた説明。',
          summaryMeta: { source: 'human' },
        },
        {
          packageId: pkg.id,
          name: 'c',
          format: 'CSV',
          size: 1000,
          state: 'active',
          summary: 'AI が書いた抄録。',
          summaryMeta: { source: 'ai', hidden: true },
        },
      ])

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      // Neither is ever billed — one is never overwritten, the other never
      // regenerated — so quoting for them overstates a curated catalogue
      expect(body.fill.resources).toBe(1)
      expect(body.fill.estimatedOutputTokens).toBe(300)
    })

    it('prices both token counts where the model has a recorded rate', async () => {
      const orgId = await ensureOrg('estimate-cost-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-cost-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        { packageId: pkg.id, name: 'a', format: 'CSV', size: 1000, state: 'active' },
      ])
      const priced = 'jp.anthropic.claude-sonnet-4-6'
      const pricedApp = createTestApp(db, {
        search: mockSearch,
        ai: {
          ...mockCompletionAi(),
          // The deployment has to have approved the model before it can be
          // named, priced or invoked
          getCompletionInfo: () => ({
            provider: 'bedrock',
            defaultModel: priced,
            allowlist: [priced],
          }),
        } as unknown as AIAdapter,
        env: { AI_SUMMARY_MODEL: priced },
      })

      const body = await (await pricedApp.request('/api/v1/admin/summary-estimate')).json()

      // 2,000 input and 300 output tokens at $3.30 / $16.50 per million
      expect(body.fill.estimatedCostUsd.low).toBeCloseTo(0.01, 2)
    })

    it('does not quote for a file this same model has already refused', async () => {
      // The refusal stands until something about the generation changes, so
      // counting it would promise work the ordinary generation will not do
      // Derived, not spelled: raising the generation version must not quietly
      // turn this fixture into the "moved off" case the row below it tests
      const thisGeneration = generationKey('gemma4:e4b', 'ja')
      const orgId = await ensureOrg('estimate-rejected-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-rejected-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      const rows = await db
        .insert(resource)
        .values([
          { packageId: pkg.id, name: 'a', format: 'CSV', size: 1000, state: 'active', hash: 'ha' },
          {
            packageId: pkg.id,
            name: 'b',
            format: 'CSV',
            size: 1000,
            state: 'active',
            hash: 'h',
            summaryMeta: { skipReason: 'rejected', genKey: thisGeneration, version: 1 },
          },
          {
            packageId: pkg.id,
            name: 'c',
            format: 'CSV',
            size: 1000,
            state: 'active',
            hash: 'hc',
            // Refused by a model this deployment has moved off — worth another try
            summaryMeta: { skipReason: 'rejected', genKey: 'some.older-model|1|ja', version: 1 },
          },
          {
            packageId: pkg.id,
            name: 'd',
            format: 'CSV',
            size: 1000,
            state: 'active',
            hash: 'h2',
            // Refused by this same model, but the file has moved on since —
            // the worker retries it, so the estimate has to count it
            summaryMeta: { skipReason: 'rejected', genKey: thisGeneration, version: 1 },
          },
        ])
        .returning({ id: resource.id, name: resource.name })
      const idOf = (name: string) => rows.find((r) => r.name === name)!.id
      // Every one of them has material; what separates them is the refusal
      await db.insert(resourcePipeline).values(
        rows.map((r) => ({
          resourceId: r.id,
          status: 'complete',
          previewKey: `previews/${r.id}.parquet`,
          metadata: { schema: { columns: [], rowCount: 0 } },
        }))
      )
      await db.insert(resourceVersion).values([
        // a and c are only reachable once a version holds their content
        {
          resourceId: idOf('a'),
          version: 1,
          storageKey: 'ka',
          hash: 'ha',
          origin: 'upload',
          state: 'active',
        },
        {
          resourceId: idOf('c'),
          version: 1,
          storageKey: 'kc',
          hash: 'hc',
          origin: 'upload',
          state: 'active',
        },
        {
          resourceId: idOf('b'),
          version: 1,
          storageKey: 'k',
          hash: 'h',
          origin: 'upload',
          state: 'active',
        },
        {
          resourceId: idOf('d'),
          version: 2,
          storageKey: 'k2',
          hash: 'h2',
          origin: 'upload',
          state: 'active',
        },
      ])

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      // a (never tried), c (another model) and d (the file changed) — not b
      expect(body.fill.resources).toBe(3)
    })

    it('quotes for an abstract whose version has been replaced', async () => {
      // The run writes it: an abstract stands while its version stands, and
      // this one's has not. Counted in neither total, the fill button quotes a
      // price and then bills past it — and where these are all a catalogue has,
      // it reads zero and the screen disables a button the run would act on.
      const thisGeneration = generationKey('gemma4:e4b', 'ja')
      const orgId = await ensureOrg('estimate-stale-version-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-stale-version-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        {
          packageId: pkg.id,
          name: 'replaced',
          format: 'CSV',
          size: 1000,
          state: 'active',
          summary: '前の版の抄録。',
          summaryMeta: { source: 'ai', genKey: thisGeneration, version: 1 },
        },
        {
          packageId: pkg.id,
          name: 'current',
          format: 'CSV',
          size: 1000,
          state: 'active',
          summary: 'いまの版の抄録。',
          summaryMeta: { source: 'ai', genKey: thisGeneration, version: 1 },
        },
      ])
      // Only the first resource's content moved on
      const [replaced] = await db
        .select({ id: resource.id, hash: resource.hash })
        .from(resource)
        .where(eq(resource.name, 'replaced'))
      await db.insert(resourceVersion).values({
        resourceId: replaced.id,
        version: 2,
        storageKey: `k-${replaced.id}-v2`,
        hash: replaced.hash!,
        origin: 'upload',
        state: 'active',
      })

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      expect(body.fill.resources).toBe(1)
      // And not twice over: a refresh covers the same one, plus nothing else
      expect(body.refresh.resources).toBe(1)
    })

    it('does not quote for a resource no version holds', async () => {
      // The walk reads the abstract from a version's settled bytes, so a
      // resource with none is one it can never visit. Quoting for it is money
      // against work nobody will do — 27 of the 92 resources the first
      // catalogue this ran against were in this state.
      const orgId = await ensureOrg('estimate-versionless-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-versionless-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        { packageId: pkg.id, name: 'reachable', format: 'CSV', size: 1000, state: 'active' },
      ])
      await db.insert(resource).values([
        // Never through the pipeline: no version, no hash
        { packageId: pkg.id, name: 'never-run', format: 'CSV', size: 1000, state: 'active' },
        // A hash the live versions no longer hold — the content was purged
        {
          packageId: pkg.id,
          name: 'orphaned',
          format: 'CSV',
          size: 1000,
          state: 'active',
          hash: 'gone',
        },
      ])

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      expect(body.fill.resources).toBe(1)
    })

    it('does not quote for a table the pipeline left nothing to describe', async () => {
      // Asked of the artifacts on every estimate, not of the reason a past run
      // recorded: a re-interpretation that finally writes a schema does not
      // create a version, so a refusal pinned to one would hide work that will
      // happen — and understating a bill is the worse way to be wrong.
      const orgId = await ensureOrg('estimate-material-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-material-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      await insertReachable([
        { packageId: pkg.id, name: 'interpreted', format: 'CSV', size: 1000, state: 'active' },
      ])
      const [bare] = await db
        .insert(resource)
        .values({
          packageId: pkg.id,
          name: 'bare',
          format: 'CSV',
          size: 1000,
          state: 'active',
          hash: 'bare-hash',
        })
        .returning({ id: resource.id })
      await db.insert(resourceVersion).values({
        resourceId: bare.id,
        version: 1,
        storageKey: 'kb',
        hash: 'bare-hash',
        origin: 'upload',
        state: 'active',
      })
      // The run finished and left a preview but no schema — 9 of the CSVs in
      // the first catalogue this ran against. The schema is the table's
      // material; the sample rows are an enhancement the query path refuses on
      // its own, so a preview alone is nothing to describe.
      await db.insert(resourcePipeline).values({
        resourceId: bare.id,
        status: 'complete',
        previewKey: 'previews/bare.parquet',
        metadata: {},
      })

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      expect(body.fill.resources).toBe(1)
      expect(body.skipped.noMaterial).toBe(1)
    })

    it("classifies on the live version's label, not the row's", async () => {
      // The walk reads the version's format (ADR-046 §6); the row's is a label
      // an editor can change without refetching. Classified on the row, the
      // estimate quotes for a path the worker will not take — or quotes
      // nothing while the worker generates.
      const orgId = await ensureOrg('estimate-relabel-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-relabel-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      const [row] = await db
        .insert(resource)
        // Relabelled ZIP, but the version still holds the CSV that was fetched
        .values({
          packageId: pkg.id,
          name: 'relabelled',
          format: 'ZIP',
          size: 1000,
          state: 'active',
          hash: 'relabel-hash',
        })
        .returning({ id: resource.id })
      await db.insert(resourceVersion).values({
        resourceId: row.id,
        version: 1,
        storageKey: 'kr',
        hash: 'relabel-hash',
        format: 'CSV',
        size: 1000,
        origin: 'upload',
        state: 'active',
      })
      // A schema, which is a table's material and not an archive's
      await db.insert(resourcePipeline).values({
        resourceId: row.id,
        status: 'complete',
        metadata: { schema: { columns: [], rowCount: 0 } },
      })

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      // Counted as the table it is. On the row's label it would have been an
      // archive with no manifest — nothing at all.
      expect(body.fill.resources).toBe(1)
      expect(body.skipped.noMaterial).toBe(0)
    })

    it('does not quote for artifacts a failed step left behind', async () => {
      // A re-interpretation that failed leaves the previous version's schema on
      // the row. The worker refuses it — the artifacts describe content the
      // resource no longer has — so quoting for it promises work that ends in
      // no-material.
      const orgId = await ensureOrg('estimate-failed-step-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'estimate-failed-step-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      const rows = await insertReachable([
        { packageId: pkg.id, name: 'clean', format: 'CSV', size: 1000, state: 'active' },
        { packageId: pkg.id, name: 'stale', format: 'CSV', size: 1000, state: 'active' },
      ])
      const staleId = rows.find((r) => r.name === 'stale')!.id
      const [pipeline] = await db
        .select({ id: resourcePipeline.id })
        .from(resourcePipeline)
        .where(eq(resourcePipeline.resourceId, staleId))
      await db.insert(resourcePipelineStep).values({
        pipelineId: pipeline.id,
        stepName: 'interpret',
        status: 'error',
        error: 'could not read the delimiter',
      })

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()

      expect(body.fill.resources).toBe(1)
      expect(body.skipped.noMaterial).toBe(1)
    })

    it('leaves private and non-active packages out of the estimate', async () => {
      const orgId = await ensureOrg('estimate-private-org')
      const [priv] = await db
        .insert(packageTable)
        .values({ name: 'estimate-priv', ownerOrg: orgId, state: 'active', private: true })
        .returning({ id: packageTable.id })
      const [draft] = await db
        .insert(packageTable)
        .values({ name: 'estimate-draft', ownerOrg: orgId, state: 'draft' })
        .returning({ id: packageTable.id })
      await insertReachable([
        { packageId: priv.id, name: 'p', format: 'CSV', size: 1000, state: 'active' },
        { packageId: draft.id, name: 'd', format: 'CSV', size: 1000, state: 'active' },
      ])

      const body = await (await summaryApp.request('/api/v1/admin/summary-estimate')).json()
      expect(body.fill.resources).toBe(0)
    })
  })

  describe('GET /api/v1/admin/jobs/stats', () => {
    it('should reject non-sysadmin requests', async () => {
      const res = await nonAdminApp.request('/api/v1/admin/jobs/stats')
      expect(res.status).toBe(403)
    })

    it('should count pipeline rows by status', async () => {
      const orgId = await ensureOrg('jobs-org')
      const [pkg] = await db
        .insert(packageTable)
        .values({ name: 'jobs-pkg', ownerOrg: orgId, state: 'active' })
        .returning({ id: packageTable.id })
      // One pipeline row per resource — resource_id is unique on that table
      const rows = await db
        .insert(resource)
        .values(
          ['jobs-a', 'jobs-b', 'jobs-c'].map((name) => ({
            packageId: pkg.id,
            name,
            state: 'active' as const,
          }))
        )
        .returning({ id: resource.id })
      await db.insert(resourcePipeline).values([
        { resourceId: rows[0].id, status: 'complete' },
        { resourceId: rows[1].id, status: 'complete' },
        { resourceId: rows[2].id, status: 'error' },
      ])

      const res = await app.request('/api/v1/admin/jobs/stats')
      expect(res.status).toBe(200)
      const body = await res.json()

      // Numbers, not bigint strings — the count no longer carries an ::int cast.
      expect(body.jobs).toEqual({ complete: 2, error: 1 })
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
