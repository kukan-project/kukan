/**
 * KUKAN MCP Route
 * Streamable HTTP transport endpoint for MCP protocol
 */

import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AppContext } from '../context'
import { createMcpServer } from '../mcp/server'
import { catalogLanguage } from '../services/catalog-language'

export const mcpRouter = new Hono<{ Variables: AppContext }>()

/**
 * Whether the request opens a session: only its response carries the server's
 * instructions, so only then is the catalog's language looked up for them.
 */
function initializes(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some(
    (message) => (message as { method?: unknown } | null)?.method === 'initialize'
  )
}

// POST /api/mcp — JSON-RPC requests (initialize, tools/list, tools/call)
mcpRouter.post('/', async (c) => {
  // Read once here and handed on: a body that is not JSON goes to the transport
  // unread, for it to answer as a parse error
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  const language = initializes(body) ? await catalogLanguage(c.get('db')) : null
  // AppContext is a structural superset of McpContext
  const server = createMcpServer(c.var, language)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
    enableJsonResponse: true,
  })

  await server.connect(transport)
  try {
    return await transport.handleRequest(
      c.req.raw,
      body === undefined ? undefined : { parsedBody: body }
    )
  } finally {
    await server.close()
  }
})

// GET /api/mcp — SSE stream (not used in stateless mode, return method not allowed)
mcpRouter.get('/', (c) => {
  return c.json(
    {
      type: 'about:blank',
      title: 'METHOD_NOT_ALLOWED',
      status: 405,
      detail: 'This MCP server operates in stateless mode. Use POST for JSON-RPC requests.',
    },
    405
  )
})

// DELETE /api/mcp — Session termination (not used in stateless mode)
mcpRouter.delete('/', (c) => {
  return c.json(
    {
      type: 'about:blank',
      title: 'METHOD_NOT_ALLOWED',
      status: 405,
      detail: 'This MCP server operates in stateless mode. Sessions are not supported.',
    },
    405
  )
})
