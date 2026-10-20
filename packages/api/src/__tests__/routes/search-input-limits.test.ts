/**
 * The bounds on a dataset search's query and paging, on each path that reaches
 * the index: they refuse before anything is read, so no database is needed
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLogger, SEARCH_QUERY_MAX_CHARS, SEARCH_RESULT_WINDOW } from '@kukan/shared'
import type { AppContext } from '../../context'
import { errorHandler } from '../../middleware/error-handler'
import { packagesRouter } from '../../routes/packages'
import { ckanCompatRouter } from '../../routes/ckan-compat'
import { registerDatasetTools } from '../../mcp/tools/datasets'

/** Stands for the database and the search: counts the requests the bounds let through */
let reached = 0
const unreachable = new Proxy(
  {},
  {
    get() {
      reached++
      throw new Error('reached the database')
    },
  }
)
beforeEach(() => {
  reached = 0
})

function createApp() {
  const app = new Hono<{ Variables: AppContext }>()
  app.use('*', async (c, next) => {
    c.set('logger', createLogger({ name: 'test', level: 'silent' }))
    c.set('env', { BETTER_AUTH_URL: 'http://localhost:3000' } as AppContext['env'])
    c.set('db', unreachable as AppContext['db'])
    c.set('search', unreachable as AppContext['search'])
    c.set('dbSearch', unreachable as AppContext['dbSearch'])
    c.set('ai', unreachable as AppContext['ai'])
    await next()
  })
  app.onError(errorHandler)
  app.route('/api/v1/packages', packagesRouter)
  app.route('/api/3/action', ckanCompatRouter)
  return app
}

const longQ = 'あ'.repeat(SEARCH_QUERY_MAX_CHARS + 1)

describe('GET /api/v1/packages bounds', () => {
  const app = createApp()

  it('refuses a q longer than the cap', async () => {
    const res = await app.request(`/api/v1/packages?q=${encodeURIComponent(longQ)}`)
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toMatch(/^q: /)
  })

  it('refuses offset + limit past the result window', async () => {
    const res = await app.request(`/api/v1/packages?offset=${SEARCH_RESULT_WINDOW - 19}&limit=20`)
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toContain(`offset + limit must be at most`)
    expect(reached).toBe(0)
  })

  it('lets the last page inside the window through', async () => {
    const q = 'あ'.repeat(SEARCH_QUERY_MAX_CHARS)
    const res = await app.request(
      `/api/v1/packages?q=${encodeURIComponent(q)}&offset=${SEARCH_RESULT_WINDOW - 20}&limit=20`
    )
    expect(res.status).toBe(500)
    expect(reached).toBeGreaterThan(0)
  })

  it('does not cap the dashboard listing, which reads PostgreSQL', async () => {
    const res = await app.request(
      `/api/v1/packages?my_org=true&offset=${SEARCH_RESULT_WINDOW}&limit=20`
    )
    expect(res.status).toBe(500)
    expect(reached).toBeGreaterThan(0)
  })
})

describe('POST /api/v1/packages/highlights bounds', () => {
  it('refuses a q longer than the cap', async () => {
    const res = await createApp().request('/api/v1/packages/highlights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: longQ, chunks: ['r_chunk_0'] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('CKAN package_search bounds', () => {
  const app = createApp()

  async function expectRefused(res: Response, field: string) {
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.__type).toBe('Validation Error')
    expect(body.error[field]).toBeDefined()
    expect(reached).toBe(0)
  }

  it('refuses a q longer than the cap', async () => {
    const res = await app.request(`/api/3/action/package_search?q=${encodeURIComponent(longQ)}`)
    await expectRefused(res, 'q')
  })

  it('refuses start + rows past the result window', async () => {
    const res = await app.request(`/api/3/action/package_search?start=9500&rows=1000`)
    await expectRefused(res, 'start')
  })

  it('refuses the same over a POST body', async () => {
    const res = await app.request('/api/3/action/package_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: SEARCH_RESULT_WINDOW, rows: 1 }),
    })
    await expectRefused(res, 'start')
  })

  it('counts rows as capped at its ceiling', async () => {
    // rows=5000 reads as 1000, so 9000 + 1000 is inside the window
    const res = await app.request(`/api/3/action/package_search?start=9000&rows=5000`)
    expect(res.status).toBe(500)
    expect(reached).toBeGreaterThan(0)
  })
})

describe('MCP search_datasets bounds', () => {
  async function connect() {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerDatasetTools(server, {
      db: unreachable,
      search: unreachable,
      dbSearch: unreachable,
      ai: unreachable,
      logger: createLogger({ name: 'test', level: 'silent' }),
    } as Parameters<typeof registerDatasetTools>[1])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientTransport)
    return client
  }

  const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n')

  it('refuses a q longer than the cap', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'search_datasets', arguments: { q: longQ } })
    expect(result.isError).toBe(true)
  })

  it('refuses offset + limit past the result window', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'search_datasets',
      arguments: { q: 'survey', offset: SEARCH_RESULT_WINDOW - 5, limit: 10 },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('offset + limit must be at most')
    expect(reached).toBe(0)
  })

  it('lets the last page inside the window through', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'search_datasets',
      arguments: { q: 'survey', offset: SEARCH_RESULT_WINDOW - 10, limit: 10 },
    })
    expect(text(result)).toContain('reached the database')
    expect(reached).toBeGreaterThan(0)
  })
})
