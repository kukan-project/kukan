/**
 * Route-level wiring test for hybrid search (ADR-034): an embedding-capable
 * stub AI adapter exercises the semantic path end to end (HTTP → hybridSearch
 * → pgvector → PackageService.list), which the other route tests never reach
 * because they run with the NoOp adapter.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'

const db = getTestDb()

/** Embedding-capable stub: every query text embeds to [1, 0, 0] */
const stubAi = {
  getEmbeddingInfo: () => ({ model: 'test-model', dimensions: 3 }),
  embed: async () => [1, 0, 0],
  embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  complete: async () => '',
} as unknown as AIAdapter

const app = createTestApp(db, { search: new PostgresSearchAdapter(db), ai: stubAi })

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()

  const orgRes = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'hybrid-org' }),
  })
  const orgId = (await orgRes.json()).id

  const createPackage = (name: string, title: string) =>
    app.request('/api/v1/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, title, ownerOrg: orgId }),
    })
  // Semantic-only hit: no keyword overlap with "Wi-Fi", embedding matches the query vector
  await createPackage('wireless-lan', '公衆無線LAN一覧')
  // Keyword-only hit: title contains "Wi-Fi", embedding orthogonal (below the threshold)
  await createPackage('keyword-hit', 'Wi-Fi設置場所')

  await db.execute(sql`
    UPDATE package SET embedding = '[1,0,0]', embedding_model = 'test-model'
    WHERE name = 'wireless-lan'
  `)
  await db.execute(sql`
    UPDATE package SET embedding = '[0,0,1]', embedding_model = 'test-model'
    WHERE name = 'keyword-hit'
  `)
})

afterAll(async () => {
  await closeTestDb()
})

async function search(qs: string) {
  const res = await app.request(`/api/v1/packages?${qs}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    items: Array<{ name: string; matchSource?: string }>
    total: number
  }
  return body
}

describe('GET /api/v1/packages — hybrid search wiring', () => {
  it('fuses vector hits (matchSource=semantic) with keyword hits', async () => {
    const { items, total } = await search('q=Wi-Fi')

    const names = items.map((i) => i.name)
    expect(names).toContain('keyword-hit')
    expect(names).toContain('wireless-lan')
    expect(total).toBe(2)

    expect(items.find((i) => i.name === 'wireless-lan')?.matchSource).toBe('semantic')
    expect(items.find((i) => i.name === 'keyword-hit')?.matchSource).toBeUndefined()
  })

  it('semantic=false disables the vector leg', async () => {
    const { items } = await search('q=Wi-Fi&semantic=false')
    expect(items.map((i) => i.name)).toEqual(['keyword-hit'])
  })

  it('my_org=true stays keyword-only (deterministic dashboard filter)', async () => {
    const { items } = await search('q=Wi-Fi&my_org=true')
    expect(items.map((i) => i.name)).toEqual(['keyword-hit'])
  })
})
