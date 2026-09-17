import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const adapter = new PostgresSearchAdapter(db)

const MODEL = 'test-model'

/** A resource carrying a vector (ADR-054) — the unit the search reads */
async function insertResource(
  packageId: string,
  opts: { name?: string; embedding?: number[]; model?: string; state?: string } = {}
): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO resource (package_id, name, state, embedding, embedding_model)
    VALUES (
      ${packageId},
      ${opts.name ?? 'r'},
      ${opts.state ?? 'active'},
      ${opts.embedding ? JSON.stringify(opts.embedding) : null},
      ${opts.embedding ? (opts.model ?? MODEL) : null}
    )
    RETURNING id
  `)
  return (result.rows[0] as { id: string }).id
}

/** A package, with one embedded resource when a vector is given */
async function insertPackage(opts: {
  name: string
  embedding?: number[]
  model?: string
  isPrivate?: boolean
  ownerOrg?: string | null
  state?: string
}): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO package (name, private, owner_org, state)
    VALUES (${opts.name}, ${opts.isPrivate ?? false}, ${opts.ownerOrg ?? null}, ${opts.state ?? 'active'})
    RETURNING id
  `)
  const id = (result.rows[0] as { id: string }).id
  if (opts.embedding) await insertResource(id, { embedding: opts.embedding, model: opts.model })
  return id
}

async function insertOrg(name: string): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO organization (name, state) VALUES (${name}, 'active') RETURNING id
  `)
  return (result.rows[0] as { id: string }).id
}

beforeEach(async () => {
  await cleanDatabase()
})

afterAll(async () => {
  await closeTestDb()
})

describe('PostgresSearchAdapter.searchByVector', () => {
  it('returns hits ordered by cosine similarity', async () => {
    const near = await insertPackage({ name: 'near', embedding: [0.9, 0.1, 0] })
    const exact = await insertPackage({ name: 'exact', embedding: [1, 0, 0] })
    await insertPackage({ name: 'orthogonal', embedding: [0, 0, 1] })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)

    // orthogonal (similarity 0) is cut by the similarity threshold
    expect(hits.map((h) => h.id)).toEqual([exact, near])
    expect(hits[0].similarity).toBeCloseTo(1, 5)
    expect(hits[1].similarity).toBeGreaterThan(0.9)
  })

  it('places a package at its closest resource, and names that resource (ADR-054)', async () => {
    const pkg = await insertPackage({ name: 'sheets' })
    await insertResource(pkg, { name: 'far', embedding: [0.5, 0.5, 0] })
    const close = await insertResource(pkg, { name: 'close', embedding: [0.95, 0.05, 0] })
    await insertResource(pkg, { name: 'gone', embedding: [1, 0, 0], state: 'deleted' })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)

    // One row for the package, carrying its best *active* resource
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id: pkg, resourceId: close })
    expect(hits[0].similarity).toBeGreaterThan(0.99)
  })

  it("fills the window with distinct packages, not one package's resources", async () => {
    const many = await insertPackage({ name: 'many' })
    for (let i = 0; i < 5; i++) await insertResource(many, { embedding: [1, 0.01 * i, 0] })
    const other = await insertPackage({ name: 'other', embedding: [0.8, 0.2, 0] })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 2)

    expect(hits.map((h) => h.id)).toEqual([many, other])
  })

  it('only matches vectors from the requested embedding model', async () => {
    await insertPackage({ name: 'other-model', embedding: [1, 0, 0], model: 'other-model' })
    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)
    expect(hits).toEqual([])
  })

  it('excludes packages without an embedding', async () => {
    await insertPackage({ name: 'no-embedding' })
    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)
    expect(hits).toEqual([])
  })

  it('applies visibility filters (excludePrivate)', async () => {
    const pub = await insertPackage({ name: 'public', embedding: [1, 0, 0] })
    await insertPackage({ name: 'private', embedding: [1, 0, 0], isPrivate: true })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, { excludePrivate: true }, 10)

    expect(hits.map((h) => h.id)).toEqual([pub])
  })

  it('respects the k limit', async () => {
    await insertPackage({ name: 'p1', embedding: [1, 0, 0] })
    await insertPackage({ name: 'p2', embedding: [0.9, 0.1, 0] })
    await insertPackage({ name: 'p3', embedding: [0.8, 0.2, 0] })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 2)
    expect(hits).toHaveLength(2)
  })

  it('excludes deleted packages (default state filter)', async () => {
    const active = await insertPackage({ name: 'active-pkg', embedding: [1, 0, 0] })
    await insertPackage({ name: 'deleted-pkg', embedding: [1, 0, 0], state: 'deleted' })

    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)

    expect(hits.map((h) => h.id)).toEqual([active])
  })

  it('shows private packages to members via allowPrivateOrgIds', async () => {
    const orgId = await insertOrg('vector-test-org')
    const priv = await insertPackage({
      name: 'member-private',
      embedding: [1, 0, 0],
      isPrivate: true,
      ownerOrg: orgId,
    })

    const hidden = await adapter.searchByVector([1, 0, 0], MODEL, { excludePrivate: true }, 10)
    expect(hidden).toEqual([])

    const visible = await adapter.searchByVector(
      [1, 0, 0],
      MODEL,
      { excludePrivate: true, allowPrivateOrgIds: [orgId] },
      10
    )
    expect(visible.map((h) => h.id)).toEqual([priv])
  })

  it('honors a custom similarity threshold', async () => {
    await insertPackage({ name: 'near-miss', embedding: [0.7, 0.7, 0] }) // similarity ≈ 0.70
    const strict = new PostgresSearchAdapter(db, { vectorMinSimilarity: 0.9 })

    expect(await strict.searchByVector([1, 0, 0], MODEL, {}, 10)).toEqual([])
    expect(await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)).toHaveLength(1)
  })

  it('facetsForIds aggregates facets for the given package set', async () => {
    const orgId = await insertOrg('facet-org')
    const p1 = await insertPackage({ name: 'facet-p1', ownerOrg: orgId })
    const p2 = await insertPackage({ name: 'facet-p2', ownerOrg: orgId })
    await insertPackage({ name: 'facet-outside', ownerOrg: orgId })

    const facets = await adapter.facetsForIds([p1, p2])

    expect(facets.organizations).toEqual([{ name: 'facet-org', count: 2 }])
  })

  it('tolerates vectors of different dimensions from another model (mid-migration)', async () => {
    const current = await insertPackage({ name: 'current-model', embedding: [1, 0, 0] })
    await insertPackage({
      name: 'old-model',
      embedding: [1, 0, 0, 0],
      model: 'old-model-4d',
    })

    // Must not raise "different vector dimensions" — the CASE guard keeps the
    // distance operator away from other models' rows.
    const hits = await adapter.searchByVector([1, 0, 0], MODEL, {}, 10)
    expect(hits.map((h) => h.id)).toEqual([current])
  })
})
