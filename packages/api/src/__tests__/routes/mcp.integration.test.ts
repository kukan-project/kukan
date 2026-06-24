import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestApp } from '../test-helpers/test-app'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { PostgresSearchAdapter } from '@kukan/search-adapter'

const db = getTestDb()
const search = new PostgresSearchAdapter(db)

function mcpApp(user?: NonNullable<Parameters<typeof createTestApp>[1]>['user']) {
  return createTestApp(db, { search, user })
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
    })
  })

  describe('search_datasets', () => {
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

      const result = await mcpToolCall(app, 'get_dataset', { nameOrId: 'ds-detail' })
      const text = result.result.content[0].text as string

      expect(text).toContain('Title: Detail Test')
      expect(text).toContain('Name: ds-detail')
      expect(text).toContain(`ID: ${resource.id}`)
      expect(text).toContain('[CSV]')
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
      })

      const result = await mcpToolCall(app, 'get_resource', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('Name: data.json')
      expect(text).toContain('Format: JSON')
      expect(text).toContain('URL: http://example.com/data.json')
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
      // A pipeline row already exists (created when the resource was enqueued),
      // so upsert the schema into its metadata.
      const metadataJson = JSON.stringify({ schema })
      await db.execute(sql`
        INSERT INTO resource_pipeline (resource_id, status, metadata)
        VALUES (${resource.id}, 'complete', ${metadataJson}::jsonb)
        ON CONFLICT (resource_id)
        DO UPDATE SET status = 'complete', metadata = ${metadataJson}::jsonb
      `)

      const result = await mcpToolCall(app, 'get_resource_schema', { id: resource.id })
      const text = result.result.content[0].text as string

      expect(text).toContain('queryable')
      expect(text).toContain('Rows: 3')
      expect(text).toContain('id: integer, range 1..3')
      expect(text).toContain('name: string (nullable)')
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
