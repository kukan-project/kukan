import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { unlink } from 'node:fs/promises'
import { createTestApp, mockStorage } from '../test-helpers/test-app'
import { writeParquet } from '../test-helpers/parquet'
import {
  createQueryableResource as createQueryable,
  type QueryableResourceOptions,
} from '../test-helpers/queryable-resource'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  OUTSIDER_USER_ID,
  ensureOutsiderUser,
} from '../test-helpers/test-db'

const db = getTestDb()

// A small Parquet fixture (id BIGINT, name VARCHAR; 100 rows). The query path
// reads it through a signed URL, so that is what the stub answers with — a
// local path here, where a deployment would hand back an https one. `download`
// refuses: a regression that fell back to it would otherwise pass.
let fixturePath: string
const fixtureStorage = { ...mockStorage, getSignedUrl: async () => fixturePath }
const app = createTestApp(db, { storage: fixtureStorage })
const outsiderApp = createTestApp(db, {
  storage: fixtureStorage,
  user: { id: OUTSIDER_USER_ID, email: 'outsider@example.com', name: 'outsider', sysadmin: false },
})

async function makeFixtureParquet(): Promise<void> {
  fixturePath = await writeParquet(`SELECT i AS id, 'name' || i AS name FROM range(100) t(i)`)
}

let testOrgId: string

beforeAll(async () => {
  await makeFixtureParquet()
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await unlink(fixturePath).catch(() => {})
  await closeTestDb()
})

async function ensureTestOrg() {
  if (testOrgId) return testOrgId
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-org-query' }),
  })
  testOrgId = (await res.json()).id
  return testOrgId
}

/** A resource under the suite's one organization (`test-helpers/queryable-resource.ts`). */
async function createQueryableResource(opts?: Omit<QueryableResourceOptions, 'orgId'>) {
  return createQueryable(app, db, { ...opts, orgId: await ensureTestOrg() })
}

function query(targetApp: typeof app, id: string, sql: string) {
  return targetApp.request(`/api/v1/resources/${id}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
}

describe('POST /api/v1/resources/:id/query', () => {
  it('runs a SELECT against the data table', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, 'SELECT count(*) AS c FROM data')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.columns).toEqual(['c'])
    expect(body.rows[0].c).toBe(100)
    expect(body.truncated).toBe(false)
  })

  it('returns column names and rows for a projection', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, 'SELECT id, name FROM data ORDER BY id LIMIT 2')
    const body = await res.json()
    expect(body.columns).toEqual(['id', 'name'])
    expect(body.rows).toEqual([
      { id: 0, name: 'name0' },
      { id: 1, name: 'name1' },
    ])
  })

  it('returns 400 for a resource with no pipeline row', async () => {
    const id = await createQueryableResource({ pipeline: false })
    const res = await query(app, id, 'SELECT 1')
    expect(res.status).toBe(400)
  })

  it('returns 400 when a preview exists but the schema was not persisted', async () => {
    const id = await createQueryableResource({ noSchema: true })
    const res = await query(app, id, 'SELECT 1')
    expect(res.status).toBe(400)
  })

  it('returns 400 when a schema exists but no preview Parquet was produced', async () => {
    const id = await createQueryableResource({ noPreviewKey: true })
    const res = await query(app, id, 'SELECT 1')
    expect(res.status).toBe(400)
  })

  it('returns 400 when the preview describes replaced content (stale)', async () => {
    // A failed re-interpretation keeps the previous preview; querying it would
    // silently serve the old bytes' data.
    const id = await createQueryableResource({ stale: true })
    const res = await query(app, id, 'SELECT 1')
    expect(res.status).toBe(400)
  })

  it('returns 400 for a non-SELECT statement', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, 'DROP TABLE data')
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid SQL', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, 'SELECT nope FROM data')
    expect(res.status).toBe(400)
  })

  it('blocks filesystem access from inside the query (sandbox)', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, "SELECT * FROM read_csv('/etc/hostname')")
    expect(res.status).toBe(400)
  })

  it('returns 404 when an outsider queries a private resource', async () => {
    const id = await createQueryableResource({ private: true })
    const res = await query(outsiderApp, id, 'SELECT 1')
    expect(res.status).toBe(404)
  })

  it('rejects an over-long SQL string', async () => {
    const id = await createQueryableResource()
    const longSql = 'SELECT ' + '1,'.repeat(6000) + '1 FROM data'
    const res = await query(app, id, longSql)
    expect(res.status).toBe(400)
  })
})

describe('MCP query_resource tool', () => {
  async function mcpToolCall(id: string, sql: string) {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'query_resource', arguments: { id, sql } },
      }),
    })
    return res.json()
  }

  it('returns a Markdown table', async () => {
    const id = await createQueryableResource()
    const body = await mcpToolCall(id, 'SELECT id, name FROM data ORDER BY id LIMIT 2')
    const text = body.result.content[0].text as string
    expect(text).toContain('| id | name |')
    expect(text).toContain('| 0 | name0 |')
    expect(text).toContain('row(s)')
  })

  it('reports a blocked query as an error', async () => {
    const id = await createQueryableResource()
    const body = await mcpToolCall(id, "SELECT * FROM read_csv('/etc/hostname')")
    // MCP surfaces tool errors either as isError content or a JSON-RPC error.
    const errored = body.result?.isError === true || body.error != null
    expect(errored).toBe(true)
  })

  it('enforces the SQL length limit on the MCP path (no zValidator there)', async () => {
    const id = await createQueryableResource()
    const body = await mcpToolCall(id, 'SELECT ' + '1,'.repeat(6000) + '1 FROM data')
    const errored = body.result?.isError === true || body.error != null
    expect(errored).toBe(true)
  })
})
