import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DuckDBInstance } from '@duckdb/node-api'
import { eq } from 'drizzle-orm'
import { resource as resourceTable, resourcePipeline } from '@kukan/db'
import type { ResourceSchema } from '@kukan/shared'
import { createTestApp } from '../test-helpers/test-app'
import {
  getTestDb,
  cleanDatabase,
  closeTestDb,
  ensureTestUser,
  OUTSIDER_USER_ID,
  ensureOutsiderUser,
} from '../test-helpers/test-db'

const db = getTestDb()

// A small Parquet fixture (id BIGINT, name VARCHAR; 100 rows), served by the mock storage.
let fixture: Buffer
const fixtureStorage = {
  upload: async () => {},
  download: async () => Readable.from(fixture),
  downloadRange: async () => {
    throw Object.assign(new Error('not used'), { name: 'NoSuchKey' })
  },
  delete: async () => {},
  deleteByPrefix: async () => 0,
  getSignedUrl: async () => 'file:///test',
  getSignedUploadUrl: async () => 'https://minio.test/upload?signed=true',
  head: async () => ({ size: fixture.length }),
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = createTestApp(db, { storage: fixtureStorage as any })
const outsiderApp = createTestApp(db, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: fixtureStorage as any,
  user: { id: OUTSIDER_USER_ID, email: 'outsider@example.com', name: 'outsider', sysadmin: false },
})

const SCHEMA: ResourceSchema = {
  columns: [
    { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
    { name: 'name', type: 'string', nullable: false, nullCount: 0 },
  ],
  rowCount: 100,
}

async function makeFixtureParquet(): Promise<Buffer> {
  const path = join(tmpdir(), `kukan-fixture-${randomUUID()}.parquet`)
  const inst = await DuckDBInstance.create(':memory:')
  const conn = await inst.connect()
  await conn.run(
    `COPY (SELECT i AS id, 'name' || i AS name FROM range(100) t(i)) TO '${path}' (FORMAT parquet)`
  )
  conn.disconnectSync()
  inst.closeSync()
  const buf = await readFile(path)
  await unlink(path).catch(() => {})
  return buf
}

let testOrgId: string

beforeAll(async () => {
  fixture = await makeFixtureParquet()
})

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  await ensureOutsiderUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
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

/**
 * Create a resource and attach a pipeline row. By default it is fully queryable
 * (previewKey + schema); `pipeline: false` attaches no row, and `noSchema` /
 * `noPreviewKey` attach a partial row (the not-yet-queryable states).
 */
async function createQueryableResource(opts?: {
  private?: boolean
  pipeline?: false
  noSchema?: boolean
  noPreviewKey?: boolean
  /** Preview left behind by a failed re-interpretation of replaced content. */
  stale?: boolean
}) {
  const orgId = await ensureTestOrg()
  const pkgRes = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `q-pkg-${randomUUID().slice(0, 8)}`,
      ownerOrg: orgId,
      private: opts?.private ?? false,
    }),
  })
  const pkg = await pkgRes.json()
  const resRes = await app.request(`/api/v1/packages/${pkg.id}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'data.csv', format: 'CSV' }),
  })
  const resource = await resRes.json()

  if (opts?.pipeline !== false) {
    // Queryable requires the preview to describe the current bytes: the
    // resource's hash and the pipeline's sourceHash must match.
    await db
      .update(resourceTable)
      .set({ hash: 'sha256:live' })
      .where(eq(resourceTable.id, resource.id))
    const sourceHash = opts?.stale ? 'sha256:old' : 'sha256:live'
    await db.insert(resourcePipeline).values({
      resourceId: resource.id,
      status: 'success',
      previewKey: opts?.noPreviewKey ? null : `preview/${resource.id}.parquet`,
      metadata: opts?.noSchema
        ? { encoding: 'utf-8', sourceHash }
        : { encoding: 'utf-8', schema: SCHEMA, sourceHash },
    })
  }
  return resource.id as string
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
    expect(body.rows[0].c).toBe('100')
    expect(body.truncated).toBe(false)
  })

  it('returns column names and rows for a projection', async () => {
    const id = await createQueryableResource()
    const res = await query(app, id, 'SELECT id, name FROM data ORDER BY id LIMIT 2')
    const body = await res.json()
    expect(body.columns).toEqual(['id', 'name'])
    expect(body.rows).toEqual([
      { id: '0', name: 'name0' },
      { id: '1', name: 'name1' },
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
