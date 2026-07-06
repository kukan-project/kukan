/**
 * KUKAN MCP Route
 * Streamable HTTP transport endpoint for MCP protocol
 */

import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AppContext } from '../context'
import { createMcpServer } from '../mcp/server'

export const mcpRouter = new Hono<{ Variables: AppContext }>()

// POST /api/mcp — JSON-RPC requests (initialize, tools/list, tools/call)
mcpRouter.post('/', async (c) => {
  // AppContext is a structural superset of McpContext
  const server = createMcpServer(c.var)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
    enableJsonResponse: true,
  })

  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
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
