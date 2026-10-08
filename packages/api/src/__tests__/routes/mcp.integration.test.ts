import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestApp, mockCompletionAi, rankingSearch } from '../test-helpers/test-app'
import { artifactOf } from '../test-helpers/document-text'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { resource, resourceVersion } from '@kukan/db'
import { Readable } from 'node:stream'
import type { DocumentTextBlock } from '@kukan/shared'
import type { StorageAdapter } from '@kukan/storage-adapter'

const db = getTestDb()
const search = new PostgresSearchAdapter(db)

function mcpApp(user?: NonNullable<Parameters<typeof createTestApp>[1]>['user']) {
  return createTestApp(db, { search, user })
}

/** A deployment that writes abstracts: a named model the adapter will allow.
 *  The switch is the pair (ADR-053 §6.1), so a test of either needs both. */
function mcpAppWithSummaries() {
  return createTestApp(db, {
    search,
    ai: mockCompletionAi(),
    env: { AI_SUMMARY_MODEL: 'gemma4:e4b' },
  })
}

/** Send a JSON-RPC request to the MCP endpoint */
async function mcpRequest(app: ReturnType<typeof mcpApp>, method: string, params: unknown = {}) {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })
  return res.json()
}

/** Initialize MCP session (required before other calls) */
async function mcpInit(app: ReturnType<typeof mcpApp>) {
  return mcpRequest(app, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.1' },
  })
}

/** Call an MCP tool */
async function mcpToolCall(app: ReturnType<typeof mcpApp>, name: string, args: unknown = {}) {
  return mcpRequest(app, 'tools/call', { name, arguments: args })
}

let testOrgId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()
  testOrgId = undefined as unknown as string
})

afterAll(async () => {
  await closeTestDb()
})

async function ensureTestOrg(app: ReturnType<typeof mcpApp>) {
  if (testOrgId) return testOrgId
  const res = await app.request('/api/v1/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-org' }),
  })
  const org = await res.json()
  testOrgId = org.id
  return testOrgId
}

async function createPackage(app: ReturnType<typeof mcpApp>, data: Record<string, unknown>) {
  const orgId = await ensureTestOrg(app)
  const res = await app.request('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerOrg: orgId, ...data }),
  })
  return res.json()
}

/**
 * Put a schema on the resource's pipeline row.
 *
 * A pipeline row already exists (created when the resource was enqueued), so
 * this upserts into its metadata. Queryable needs the preview to describe the
 * current bytes, which is why the resource hash and `sourceHash` are set to
 * match; pass `previewKey: null` for a resource whose preview is gone.
 */
async function storeSchema(
  resourceId: string,
  schema: Record<string, unknown>,
  previewKey: string | null = 'previews/test.parquet'
) {
  await db.execute(sql`UPDATE resource SET hash = 'sha256:live' WHERE id = ${resourceId}`)
  const metadataJson = JSON.stringify({ schema, sourceHash: 'sha256:live' })
  await db.execute(sql`
    INSERT INTO resource_pipeline (resource_id, status, preview_key, metadata)
    VALUES (${resourceId}, 'complete', ${previewKey}, ${metadataJson}::jsonb)
    ON CONFLICT (resource_id)
    DO UPDATE SET status = 'complete', preview_key = ${previewKey}, metadata = ${metadataJson}::jsonb
  `)
}

async function createResource(
  app: ReturnType<typeof mcpApp>,
  packageId: string,
  data: Record<string, unknown>
) {
  const res = await app.request(`/api/v1/packages/${packageId}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-resource', format: 'CSV', ...data }),
  })
  expect(res.status).toBe(201)
  return res.json()
}

describe('MCP Server', () => {
  describe('initialize', () => {
    it('should return server info and capabilities', async () => {
      const app = mcpApp()
      const result = await mcpInit(app)

      expect(result.result).toMatchObject({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'kukan', version: '1.0.0' },
        capabilities: { tools: { listChanged: true } },
      })
    })
  })

  describe('tools/list', () => {
    it('should return all registered tools', async () => {
      const app = mcpApp()
      await mcpInit(app)
      const result = await mcpRequest(app, 'tools/list')

      const toolNames = result.result.tools.map((t: { name: string }) => t.name)
      expect(toolNames).toContain('search_datasets')
      expect(toolNames).toContain('get_dataset')
      expect(toolNames).toContain('get_resource')
      expect(toolNames).toContain('get_resource_schema')
      expect(toolNames).toContain('list_organizations')
      expect(toolNames).toContain('list_groups')
      expect(toolNames).toContain('list_tags')
      expect(toolNames).toContain('get_document_section')
      expect(toolNames).toContain('get_document_outline')
    })
  })

  describe('search_datasets', () => {
    it('does not describe a dataset the index still ranks after it was made private', async () => {
      const owner = mcpApp()
      const shown = await createPackage(owner, { name: 'mcp-shown', title: 'Shown Survey' })
      const hidden = await createPackage(owner, {
        name: 'mcp-hidden',
        title: 'Hidden Survey',
        private: true,
      })
      const ranked = [hidden.id, shown.id]
      const staleIndex = createTestApp(db, {
        user: null,
        search: rankingSearch(ranked),
      })

      const result = await mcpToolCall(staleIndex, 'search_datasets', { q: 'survey' })
      const text = result.result.content[0].text as string
      expect(text).toContain('Shown Survey')
      expect(text).not.toContain('Hidden Survey')
    })

    it('should return empty results for no match', async () => {
      const app = mcpApp()
      const result = await mcpToolCall(app, 'search_datasets', { q: 'nonexistent' })

      expect(result.result.content[0].text).toContain('No datasets found')
    })

    it('should return matching datasets with offset/limit', async () => {
      const app = mcpApp()
      await createPackage(app, { name: 'ds-1', title: 'Environment Data' })
      await createPackage(app, { name: 'ds-2', title: 'Environment Report' })

      const result = await mcpToolCall(app, 'search_datasets', {
        q: 'environment',
        limit: 1,
        offset: 0,
      })
      const text = result.result.content[0].text as string
      expect(text).toContain('Total: 2 datasets found (showing 1)')
    })

    it("lists each dataset's formats, read from its resources", async () => {
      // The search index keeps formats on the resources alone, so the tool
      // asks the database for the datasets it shows
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-formats', title: 'Station Map' })
      await createResource(app, pkg.id, { name: 'stations.csv', format: 'csv' })
      await createResource(app, pkg.id, { name: 'stations.geojson', format: 'GeoJSON' })
      await createResource(app, pkg.id, { name: 'more.csv', format: 'CSV' })

      const result = await mcpToolCall(app, 'search_datasets', { q: 'station' })
      const text = result.result.content[0].text as string

      expect(text).toContain('Formats: CSV, GEOJSON')
    })

    it('names which file in a dataset matched, and on what account', async () => {
      // The dataset is the unit of the result and the wrong unit to act on:
      // without this the caller's next move is to fetch it and guess (ADR-054).
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-many', title: 'Facility Survey' })
      await createResource(app, pkg.id, { name: 'unrelated.csv', format: 'CSV' })
      await createResource(app, pkg.id, {
        name: 'shelters.csv',
        format: 'CSV',
        description: 'evacuation shelters by district',
      })

      const result = await mcpToolCall(app, 'search_datasets', { q: 'shelters' })
      const text = result.result.content[0].text as string

      expect(text).toContain('Matched files:')
      expect(text).toContain('shelters.csv')
      expect(text).toContain('in its name or description')
      expect(text).not.toContain('unrelated.csv')
    })
  })

  describe('get_dataset', () => {
    it('should return dataset details with resource IDs', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-detail', title: 'Detail Test' })
      const resource = await createResource(app, pkg.id, {
        name: 'test.csv',
        format: 'CSV',
        url: 'http://example.com/test.csv',
      })
      await createResource(app, pkg.id, { name: 'readme.md', section: 'docs' })
      await createResource(app, pkg.id, { name: 'schema.md', section: 'docs/spec' })
      await createResource(app, pkg.id, { name: 'notes.txt' })

      const result = await mcpToolCall(app, 'get_dataset', { nameOrId: 'ds-detail' })
      const text = result.result.content[0].text as string

      expect(text).toContain('Title: Detail Test')
      expect(text).toContain('Name: ds-detail')
      expect(text).toContain(`ID: ${resource.id}`)
      expect(text).toContain('[CSV]')
      // Headings as the public page draws them: nested by `/`, members a level
      // deeper, and a root resource after a run back at the margin
      expect(text).toMatch(
        /^ {2}1\. test\.csv.*\n {2}\[docs\]\n {4}2\. readme\.md.*\n {4}\[spec\]\n {6}3\. schema\.md.*\n {2}4\. notes\.txt/m
      )
    })
  })

  describe('get_resource', () => {
    it('should return resource metadata with URL', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-res', title: 'Resource Test' })
      const resource = await createResource(app, pkg.id, {
        name: 'data.json',
        format: 'JSON',
        url: 'http://example.com/data.json',
        section: 'raw',
      })

      const result = await mcpToolCall(app, 'get_resource', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('Name: data.json')
      expect(text).toContain('Section: raw')
      expect(text).toContain('Format: JSON')
      expect(text).toContain('URL: http://example.com/data.json')
    })

    it('carries the abstract, what it was read from, and the version it describes', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-abstract', title: 'Abstract Test' })
      const res = await createResource(app, pkg.id, { name: 'people.csv', format: 'CSV' })
      await db
        .update(resource)
        .set({
          summary: '地区ごとの人口を収録した表である。',
          summaryMeta: {
            source: 'ai',
            version: 1,
            material: 'schema',
            coverage: { read: 100, total: 1200 },
          },
        })
        .where(eq(resource.id, res.id))

      const result = await mcpToolCall(app, 'get_resource', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('地区ごとの人口を収録した表である。')
      // The extent, because the abstract itself is forbidden to state it
      expect(text).toContain('the column layout and the first 100 of 1200 rows')
      expect(text).toContain('describes v1')
      expect(text).toContain('Generated by AI')
    })

    it('says the file has moved past the version the abstract describes', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-abstract-stale', title: 'Stale Abstract' })
      const res = await createResource(app, pkg.id, { name: 'people.csv', format: 'CSV' })
      await db
        .update(resource)
        .set({ summary: 'an older description', summaryMeta: { source: 'ai', version: 1 } })
        .where(eq(resource.id, res.id))
      await db.insert(resourceVersion).values([
        { resourceId: res.id, version: 1, state: 'active', storageKey: 'k1', origin: 'upload' },
        { resourceId: res.id, version: 2, state: 'active', storageKey: 'k2', origin: 'upload' },
      ])

      const result = await mcpToolCall(app, 'get_resource', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('describes v1, and the file is now v2')
    })

    it('gives the reason when no abstract was written', async () => {
      const app = mcpAppWithSummaries()
      const pkg = await createPackage(app, { name: 'ds-abstract-skip', title: 'Skipped Abstract' })
      const res = await createResource(app, pkg.id, { name: 'big.pdf', format: 'PDF' })
      await db
        .update(resource)
        .set({ summaryMeta: { skipReason: 'format-mismatch' } })
        .where(eq(resource.id, res.id))

      const result = await mcpToolCall(app, 'get_resource', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('No AI-written description:')
      expect(text).toContain('the source link may be dead')
    })

    it('withholds a recorded reason on a site that no longer writes abstracts', async () => {
      // The reasons outlive the setting, because they are on the row. This is
      // the wiring rather than the formatting: the tool has to be told whether
      // this deployment writes them, and nothing in the row can say so.
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-abstract-off', title: 'Abstracts Off' })
      const res = await createResource(app, pkg.id, { name: 'big.pdf', format: 'PDF' })
      await db
        .update(resource)
        .set({ summaryMeta: { skipReason: 'too-large' } })
        .where(eq(resource.id, res.id))

      const result = await mcpToolCall(app, 'get_resource', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).not.toContain('No AI-written description')
      expect(text).toContain('Name: big.pdf')
    })

    it('says nothing about abstracts on a site that writes none', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-no-abstract', title: 'No Abstract' })
      const res = await createResource(app, pkg.id, { name: 'plain.csv', format: 'CSV' })

      const result = await mcpToolCall(app, 'get_resource', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).not.toContain('description:')
      expect(text).toContain('Name: plain.csv')
    })

    it('should return download path for uploaded resources', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-upload', title: 'Upload Test' })
      const resource = await createResource(app, pkg.id, {
        name: 'uploaded.csv',
        format: 'CSV',
        url: 'uploaded.csv',
        urlType: 'upload',
      })

      const result = await mcpToolCall(app, 'get_resource', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain(`URL: /api/v1/resources/${resource.id}/download`)
    })

    it('should deny access to resource of private dataset for unauthenticated user', async () => {
      // Create private dataset as sysadmin
      const adminApp = mcpApp()
      const pkg = await createPackage(adminApp, {
        name: 'ds-private',
        title: 'Private Dataset',
        private: true,
      })
      const resource = await createResource(adminApp, pkg.id, {
        name: 'secret.csv',
        format: 'CSV',
        url: 'http://example.com/secret.csv',
      })

      // Try to access as unauthenticated user
      const anonApp = mcpApp(null)
      const result = await mcpToolCall(anonApp, 'get_resource', { id: resource.id })

      // Should get an error (NotFoundError is caught by error handler)
      expect(result.error || result.result.isError).toBeTruthy()

      // Ensure no sensitive information is leaked in the error response
      const errorText = JSON.stringify(result)
      expect(errorText).not.toContain('secret.csv')
      expect(errorText).not.toContain(pkg.id)
      expect(errorText).not.toContain('example.com/secret')
    })
  })

  describe('get_resource_schema', () => {
    it('reports not queryable when no schema is stored', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-noschema', title: 'No Schema' })
      const resource = await createResource(app, pkg.id, {
        name: 'image.png',
        format: 'PNG',
        url: 'http://example.com/image.png',
      })

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('not queryable')
    })

    it('returns columns and types when a schema is stored', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-schema', title: 'With Schema' })
      const resource = await createResource(app, pkg.id, {
        name: 'data.csv',
        format: 'CSV',
        url: 'http://example.com/data.csv',
      })

      const schema = {
        rowCount: 3,
        columns: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            nullCount: 0,
            stats: { min: '1', max: '3' },
          },
          { name: 'name', type: 'string', nullable: true, nullCount: 1 },
        ],
      }
      await storeSchema(resource.id, schema)

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('is queryable')
      expect(text).toContain('query_resource')
      expect(text).toContain('Rows: 3')
      expect(text).toContain('id: integer, range 1..3')
      expect(text).toContain('name: string (nullable)')
      // No key settled → the line is absent, not "Primary key: (none)".
      expect(text).not.toContain('Primary key')

      await db.execute(sql`
        UPDATE resource SET column_settings = '{"primaryKey": ["id"]}'::jsonb
        WHERE id = ${resource.id}
      `)
      const keyed = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      expect(keyed.result.content[0].text as string).toContain('Primary key: id')
    })

    it('gives each column its role, and the values of names and categories (ADR-063)', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-roles', title: 'Roles' })
      const resource = await createResource(app, pkg.id, {
        name: 'data.csv',
        format: 'CSV',
        url: 'http://example.com/data.csv',
      })
      await storeSchema(resource.id, {
        rowCount: 40,
        columns: [
          { name: '市区町村名', type: 'string', nullable: false, nullCount: 0, distinctCount: 40 },
          { name: '定員', type: 'string', nullable: false, nullCount: 0, distinctCount: 12 },
        ],
      })
      const profile = {
        columns: [
          {
            role: 'name',
            roleBasis: { rule: 'distinct-values', share: 1 },
            values: ['青森市', '弘前市'],
          },
          {
            role: 'numeric-text',
            roleBasis: { rule: 'number-shape', share: 1, examples: ['-', '1,000'] },
          },
        ],
      }
      await db.execute(sql`
        UPDATE resource_pipeline SET profile = ${JSON.stringify(profile)}::jsonb
        WHERE resource_id = ${resource.id}
      `)

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('市区町村名: string — name')
      // The values kept, and how many more the column has
      expect(text).toContain('values: "青森市", "弘前市", … and 38 more')
      expect(text).toContain('定員: string — numeric-text (not numbers: "-", "1,000")')
      expect(text).toContain('TRY_CAST')
    })

    it('hands over the feed URL and says what identifies its rows', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-odata', title: 'OData' })
      const resource = await createResource(app, pkg.id, {
        name: 'feed.csv',
        format: 'CSV',
        url: 'http://example.com/feed.csv',
      })
      await storeSchema(resource.id, {
        rowCount: 2,
        columns: [{ name: 'code', type: 'string', nullable: false, nullCount: 0 }],
      })

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain(`/odata/v1/resources/${resource.id}/Rows`)
      // No usable primary key, so the feed adds a column the SQL surface has not.
      expect(text).toContain('RowId')
    })

    it('reports a private dataset as the reason, not as an absent feed', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-odata-private', title: 'Private' })
      const resource = await createResource(app, pkg.id, {
        name: 'private.csv',
        format: 'CSV',
        url: 'http://example.com/private.csv',
      })
      await db.execute(sql`UPDATE package SET private = true WHERE id = ${pkg.id}`)
      await storeSchema(resource.id, {
        rowCount: 1,
        columns: [{ name: 'code', type: 'string', nullable: false, nullCount: 0 }],
      })

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('OData: not served — only resources in a public')
      expect(text).not.toContain('/odata/v1/resources')
    })

    it('says why the feed refuses a table SQL can still query', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-odata-bad', title: 'OData Refused' })
      const resource = await createResource(app, pkg.id, {
        name: 'bad-headers.csv',
        format: 'CSV',
        url: 'http://example.com/bad-headers.csv',
      })
      await storeSchema(resource.id, {
        rowCount: 1,
        columns: [{ name: '人口（人）', type: 'integer', nullable: false, nullCount: 0 }],
      })

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      // Queryable and refused at once — the pair an agent has to be told apart.
      expect(text).toContain('is queryable')
      expect(text).toContain('OData: not served')
      expect(text).toContain('人口（人）')
    })

    it('shows the schema but withholds query guidance when the preview is gone', async () => {
      const app = mcpApp()
      const pkg = await createPackage(app, { name: 'ds-purged', title: 'Purged Preview' })
      const resource = await createResource(app, pkg.id, {
        name: 'purged.csv',
        format: 'CSV',
        url: 'http://example.com/purged.csv',
      })

      const schema = {
        rowCount: 2,
        columns: [{ name: 'id', type: 'integer', nullable: false, nullCount: 0 }],
      }
      await storeSchema(resource.id, schema, null)

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      // Same contract as GET /:id/schema: the columns stay visible, only the
      // queryable claim and the query guidance drop.
      expect(text).toContain('not currently queryable')
      expect(text).toContain('id: integer')
      expect(text).not.toContain('query_resource')
    })
  })

  describe('list_organizations', () => {
    it('should list organizations', async () => {
      const app = mcpApp()
      await ensureTestOrg(app)

      const result = await mcpToolCall(app, 'list_organizations', { limit: 10 })
      const text = result.result.content[0].text as string

      expect(text).toContain('test-org')
      expect(text).toContain('Total: 1 organizations')
    })

    // Same visibility rule as search_datasets: an anonymous MCP session must
    // not see private datasets in the per-org counts, a sysadmin session must
    it('should count datasets with the caller visibility', async () => {
      const app = mcpApp()
      await createPackage(app, { name: 'mcp-pub' })
      await createPackage(app, { name: 'mcp-priv', private: true })

      const sysadmin = await mcpToolCall(app, 'list_organizations', { limit: 10 })
      expect(sysadmin.result.content[0].text).toContain('Datasets: 2')

      const anonymous = await mcpToolCall(mcpApp(null), 'list_organizations', { limit: 10 })
      expect(anonymous.result.content[0].text).toContain('Datasets: 1')
    })
  })

  describe('list_groups', () => {
    it('should return empty when no groups exist', async () => {
      const app = mcpApp()
      const result = await mcpToolCall(app, 'list_groups', { limit: 10 })
      const text = result.result.content[0].text as string

      expect(text).toBe('No groups found.')
    })
  })

  describe('list_tags', () => {
    it('should list tags from datasets', async () => {
      const app = mcpApp()
      await createPackage(app, {
        name: 'ds-tagged',
        title: 'Tagged',
        tags: [{ name: 'open-data' }, { name: 'csv' }],
      })

      const result = await mcpToolCall(app, 'list_tags', { limit: 50 })
      const text = result.result.content[0].text as string

      expect(text).toContain('open-data')
      expect(text).toContain('csv')
    })

    // Same visibility rule as search_datasets: a tag used only by a private
    // dataset must not reach an anonymous MCP session
    it('should hide private-only tags from the caller', async () => {
      const app = mcpApp()
      await createPackage(app, { name: 'mcp-tag-pub', tags: [{ name: 'pub-tag' }] })
      await createPackage(app, {
        name: 'mcp-tag-priv',
        private: true,
        tags: [{ name: 'priv-tag' }],
      })

      const sysadmin = await mcpToolCall(app, 'list_tags', { limit: 50 })
      expect(sysadmin.result.content[0].text).toContain('priv-tag')

      const anonymous = await mcpToolCall(mcpApp(null), 'list_tags', { limit: 50 })
      expect(anonymous.result.content[0].text).toContain('pub-tag')
      expect(anonymous.result.content[0].text).not.toContain('priv-tag')
    })
  })

  describe('get_document_section', () => {
    const KEY = 'previews/p/r.token.text.ndjson.zst'
    const report: DocumentTextBlock[] = [
      { loc: { page: 1 }, headings: ['はじめに'], text: '計画の目的' },
      { loc: { page: 2, label: 'ii' }, headings: ['第1章 現状'], text: '人口は減っている。' },
      { loc: { page: 3 }, text: '', unreadable: 'no-text' },
    ]

    /** An app whose storage serves `blocks` as the document's text artifact */
    function documentApp(blocks: DocumentTextBlock[], user?: Parameters<typeof mcpApp>[0]) {
      const artifact = artifactOf(blocks)
      const storage = {
        download: async (key: string) => {
          if (key !== KEY) throw new Error(`unexpected key ${key}`)
          return Readable.from([artifact])
        },
      } as unknown as StorageAdapter
      return createTestApp(db, { search, storage, user })
    }

    /** A PDF whose last finished run wrote the artifact at `key` */
    async function createDocument(
      app: ReturnType<typeof mcpApp>,
      pkgData: Record<string, unknown>,
      metadata: Record<string, unknown> = { documentTextKey: KEY, documentTextBytes: 100 }
    ) {
      const pkg = await createPackage(app, pkgData)
      const res = await createResource(app, pkg.id, {
        name: 'plan.pdf',
        format: 'PDF',
        url: 'plan.pdf',
        urlType: 'upload',
      })
      await db.update(resource).set({ hash: 'sha256:live' }).where(eq(resource.id, res.id))
      const json = JSON.stringify({ sourceHash: 'sha256:live', ...metadata })
      await db.execute(sql`
        INSERT INTO resource_pipeline (resource_id, status, metadata)
        VALUES (${res.id}, 'complete', ${json}::jsonb)
        ON CONFLICT (resource_id) DO UPDATE SET status = 'complete', metadata = ${json}::jsonb
      `)
      return { pkg, res }
    }

    async function call(app: ReturnType<typeof mcpApp>, args: Record<string, unknown>) {
      const result = await mcpToolCall(app, 'get_document_section', args)
      return result.result.content[0].text as string
    }

    it('returns the pages asked for, each labelled, under the source to cite', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-plan', title: '総合計画' })

      const text = await call(app, { id: res.id, from: 2, to: 3 })

      expect(text).toContain('Source: plan.pdf — 総合計画')
      expect(text).toContain(
        `Resource page: http://localhost:3000/dataset/ds-plan/resource/${res.id}`
      )
      expect(text).toContain(
        `File: http://localhost:3000/api/v1/resources/${res.id}/download (add #page=N`
      )
      // The source, a blank line, then the text
      expect(text).toContain('Format: PDF\nShowing: pages 2–3\n\n--- page 2')
      expect(text).toContain('--- page 2 (ii) · 第1章 現状\n人口は減っている。\n\n--- page 3')
      expect(text).toContain('--- page 3\n[This page has no text to read')
      expect(text).not.toContain('計画の目的')
      expect(text).toContain('End of the selected text.')
      expect(text).not.toContain('earlier version')
    })

    it('pages a long section with a cursor that carries the selection', async () => {
      const long = Array.from({ length: 40 }, (_, i) => `第${i}行`).join('\n')
      const app = documentApp([
        { loc: { page: 1 }, headings: ['付録'], text: long },
        { loc: { page: 2 }, headings: ['本編'], text: 'not in the section' },
      ])
      const { res } = await createDocument(app, { name: 'ds-long', title: 'Long' })

      const first = await call(app, { id: res.id, heading: '付録', max_chars: 100 })
      const cursor = first.match(/cursor "([^"]+)"/)?.[1]
      expect(cursor).toBeTruthy()

      const second = await call(app, { id: res.id, cursor })
      expect(second).toContain('--- page 1 · 付録 · (continued)')
      expect(second).toContain('第39行')
      expect(second).not.toContain('not in the section')
      expect(second).toContain('End of the selected text.')
    })

    it('names the rows of a sheet a cut part holds, not the whole block', async () => {
      const app = documentApp([
        {
          loc: { sheet: 1, sheetName: '集計', rows: [2, 3, 5, 6] },
          text: '行2\t10\n行3\t20\n行5\t30\n行6\t40',
        },
      ])
      const { res } = await createDocument(app, { name: 'ds-sheet', title: 'Sheet' })

      const first = await call(app, { id: res.id, max_chars: 12 })
      expect(first).toContain('Showing: sheet 1')
      expect(first).toContain('--- sheet 1 "集計", rows 2–3\n行2\t10\n行3\t20')
      const cursor = first.match(/cursor "([^"]+)"/)?.[1]

      const second = await call(app, { id: res.id, cursor })
      expect(second).toContain('--- sheet 1 "集計", rows 5–6 · (continued)\n行5\t30\n行6\t40')
    })

    it('refuses a cursor from before the document was extracted again', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-stale', title: 'Stale' })
      const stale = Buffer.from(
        JSON.stringify({ k: 'other', q: {}, at: { block: 1, offset: 0 } })
      ).toString('base64url')

      expect(await call(app, { id: res.id, cursor: stale })).toContain('extracted again')
      expect(await call(app, { id: res.id, cursor: 'nonsense' })).toContain('not one this tool')
    })

    it('refuses a heading of only spaces, which would match everything', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-blank', title: 'Blank' })

      const result = await mcpToolCall(app, 'get_document_section', { id: res.id, heading: '  ' })

      expect(result.error || result.result.isError).toBeTruthy()
    })

    it('says the text is not available when its object has gone', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-gone', title: 'Gone' })
      const gone = createTestApp(db, {
        search,
        storage: {
          download: async () => {
            throw Object.assign(new Error('The specified key does not exist.'), {
              name: 'NoSuchKey',
            })
          },
        } as unknown as StorageAdapter,
      })

      expect(await call(gone, { id: res.id })).toContain('not available just now')
    })

    it('points to the outline when nothing matches', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-miss', title: 'Miss' })

      const text = await call(app, { id: res.id, heading: '財政' })

      expect(text).toContain('No text matches heading "財政".')
      expect(text).toContain('run 1–3')
      expect(text).toContain('Call get_document_outline')
    })

    it('lists the headings with the pages they span, under the source', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-outline', title: '総合計画' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('Source: plan.pdf — 総合計画')
      expect(text).toContain('(add #page=N to open a PDF at page N)')
      expect(text).toContain('Pages: 1–3')
      expect(text).toContain(
        'Pages whose text cannot be read (scans, or fonts with no map, or an incomplete one, to characters): 3'
      )
      // Each heading with its pages, in one column, for a reader to choose from
      expect(text).toContain('Headings with the pages they span.')
      expect(text).toContain('page 1  はじめに\npage 2  第1章 現状')
    })

    it('says which pages have some characters left out, on the page and in the outline', async () => {
      const app = documentApp([
        { loc: { page: 1 }, text: '成２８度', unmappedChars: 2 },
        { loc: { page: 2 }, text: '本文' },
      ])
      const { res } = await createDocument(app, { name: 'ds-partly', title: 'Partly' })

      const section = await call(app, { id: res.id })
      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })

      expect(section).toContain(
        '--- page 1\n[2 characters of this page are in glyphs its fonts give no character for, and are left out of the text below.]\n成２８度\n\n--- page 2\n本文'
      )
      expect(result.result.content[0].text).toContain(
        'Pages with some characters that cannot be read, left out of their text: 1'
      )
    })

    it('says a range holds nothing, not that the document has no pages', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-past', title: 'Past' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id, from: 9 })

      expect(result.result.content[0].text).toContain('Nothing is on pages, slides or sheets 9–…')
    })

    it('cuts long headings and a long outline, saying how many it left out', async () => {
      const app = documentApp(
        Array.from({ length: 200 }, (_, i) => ({
          loc: { page: i + 1 },
          headings: [`${i + 1}`.padStart(3, '0') + '見'.repeat(200)],
          text: 'x',
        }))
      )
      const { res } = await createDocument(app, { name: 'ds-long-outline', title: 'Long' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain(`001${'見'.repeat(117)}…`)
      expect(text).not.toContain('見'.repeat(118))
      expect(text).toMatch(/… and \d+ more\. Give from\/to/)
      expect(text.length).toBeLessThan(13_000)
    })

    it('outlines a workbook by its sheets and their rows', async () => {
      const app = documentApp([
        { loc: { sheet: 1, sheetName: '集計', rows: [1, 2] }, text: 'a\nb' },
        { loc: { sheet: 2, sheetName: '内訳', rows: [3, 40] }, text: 'c\nd' },
      ])
      const { res } = await createDocument(app, { name: 'ds-book', title: 'Book' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('Sheets: 1–2')
      expect(text).toContain("Give a sheet's name as heading")
      expect(text).toContain('sheet 1  集計  (rows 1–2)\nsheet 2  内訳  (rows 3–40)')
    })

    it('says how to read a document with neither pages nor headings', async () => {
      const app = documentApp([{ loc: {}, text: '本文だけの文書' }])
      const { res } = await createDocument(app, { name: 'ds-plain', title: 'Plain' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })

      expect(result.result.content[0].text).toContain(
        'marks no headings and has no pages. Read it from the start'
      )
      expect(await call(app, { id: res.id })).toContain('本文だけの文書')
    })

    it('says so for a resource with no text, and for a scan', async () => {
      const app = documentApp(report)
      const { res: csv } = await createDocument(app, { name: 'ds-csv', title: 'CSV' }, {})
      const { res: scan } = await createDocument(
        app,
        { name: 'ds-scan', title: 'Scan' },
        { documentTextKey: KEY, documentTextBytes: 0 }
      )

      expect(await call(app, { id: csv.id })).toContain('has no extracted document text')
      expect(await call(app, { id: scan.id })).toContain('scans or images')
    })

    it('outlines a document that is all scans, which has pages and bookmarks but no text', async () => {
      const app = documentApp([
        { loc: { page: 1 }, headings: ['表紙'], text: '', unreadable: 'no-text' },
        { loc: { page: 2 }, headings: ['本文'], text: '', unreadable: 'no-text' },
      ])
      const { res } = await createDocument(
        app,
        { name: 'ds-all-scan', title: 'Scan' },
        { documentTextKey: KEY, documentTextBytes: 0 }
      )

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('Pages: 1–2')
      expect(text).toContain(
        'cannot be read (scans, or fonts with no map, or an incomplete one, to characters): 1–2'
      )
      expect(text).toContain('page 2  本文')
    })

    it('cuts a long list of unreadable pages too, saying how to see the rest', async () => {
      // Text and scans in turn: a range of one page each
      const app = documentApp(
        Array.from({ length: 4000 }, (_, i) => ({
          loc: { page: i + 1 },
          text: i % 2 ? '' : 'x',
          ...(i % 2 ? { unreadable: 'no-text' as const } : {}),
        }))
      )
      const { res } = await createDocument(app, { name: 'ds-interleaved', title: 'Interleaved' })

      const result = await mcpToolCall(app, 'get_document_outline', { id: res.id })
      const text = result.result.content[0].text as string

      expect(text).toMatch(/… and \d+ more ranges; give from\/to/)
      expect(text.length).toBeLessThan(13_000)
    })

    it('points get_resource at the document tools, where the file has text', async () => {
      const app = documentApp(report)
      const { res: pdf } = await createDocument(app, { name: 'ds-hint', title: 'Hint' })
      const { res: scan } = await createDocument(
        app,
        { name: 'ds-hint-scan', title: 'Scan' },
        { documentTextKey: KEY, documentTextBytes: 0 }
      )
      const { res: csv } = await createDocument(app, { name: 'ds-hint-csv', title: 'CSV' }, {})
      const describe = async (id: string) =>
        (await mcpToolCall(app, 'get_resource', { id })).result.content[0].text as string

      expect(await describe(pdf.id)).toContain(
        'Document text: see its headings and pages with get_document_outline, then read it with get_document_section.'
      )
      expect(await describe(scan.id)).toContain('Document text: none to read')
      expect(await describe(csv.id)).not.toContain('Document text')
    })

    it('cites the version the text is from, not the file it was replaced by', async () => {
      // Extracted from v1; v2 replaced it and its Interpret failed, leaving v1's text
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-changed', title: 'Changed' })
      await db.insert(resourceVersion).values([
        {
          resourceId: res.id,
          version: 1,
          state: 'active',
          storageKey: 'k1',
          origin: 'upload',
          hash: 'sha256:live',
        },
        {
          resourceId: res.id,
          version: 2,
          state: 'active',
          storageKey: 'k2',
          origin: 'upload',
          hash: 'sha256:new',
        },
      ])
      await db.update(resource).set({ hash: 'sha256:new' }).where(eq(resource.id, res.id))

      const text = await call(app, { id: res.id })

      expect(text).toContain('Text from: version 1\nCurrent file version: 2\nNote:')
      expect(text).not.toContain('Version: 2')
    })

    it('says the text is from an earlier version where none holds its bytes any more', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-gone-version', title: 'Gone' })
      await db.insert(resourceVersion).values([
        {
          resourceId: res.id,
          version: 2,
          state: 'active',
          storageKey: 'k2',
          origin: 'upload',
          hash: 'sha256:new',
        },
      ])
      await db.update(resource).set({ hash: 'sha256:new' }).where(eq(resource.id, res.id))

      const text = await call(app, { id: res.id })

      expect(text).toContain('Text from: an earlier version of the file\nCurrent file version: 2')
    })

    it('gives the one version where the text is from the live file', async () => {
      const app = documentApp(report)
      const { res } = await createDocument(app, { name: 'ds-live', title: 'Live' })
      await db.insert(resourceVersion).values([
        {
          resourceId: res.id,
          version: 1,
          state: 'active',
          storageKey: 'k1',
          origin: 'upload',
          hash: 'sha256:live',
        },
      ])

      const text = await call(app, { id: res.id })

      expect(text).toContain('Version: 1')
      expect(text).not.toContain('Text from')
    })

    it('does not read the text of a private dataset to someone outside it', async () => {
      const admin = documentApp(report)
      const { res } = await createDocument(admin, {
        name: 'ds-secret',
        title: 'Secret Plan',
        private: true,
      })

      const result = await mcpToolCall(documentApp(report, null), 'get_document_section', {
        id: res.id,
      })

      expect(result.error || result.result.isError).toBeTruthy()
      const body = JSON.stringify(result)
      expect(body).not.toContain('人口は減っている')
      expect(body).not.toContain('Secret Plan')
    })
  })

  describe('GET /api/mcp', () => {
    it('should return 405 for GET requests', async () => {
      const app = mcpApp()
      const res = await app.request('/api/mcp')
      expect(res.status).toBe(405)
    })
  })

  describe('DELETE /api/mcp', () => {
    it('should return 405 for DELETE requests', async () => {
      const app = mcpApp()
      const res = await app.request('/api/mcp', { method: 'DELETE' })
      expect(res.status).toBe(405)
    })
  })
})
