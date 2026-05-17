/**
 * KUKAN MCP Server
 * Creates and configures the MCP server with all tools registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import { registerDatasetTools } from './tools/datasets'
import { registerResourceTools } from './tools/resources'
import { registerCatalogTools } from './tools/catalog'

interface McpContext {
  db: Database
  search: SearchAdapter
  user?: { id: string; sysadmin: boolean }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({
    name: 'kukan',
    version: '1.0.0',
  })

  registerDatasetTools(server, { db: ctx.db, search: ctx.search, user: ctx.user })
  registerResourceTools(server, { db: ctx.db, user: ctx.user })
  registerCatalogTools(server, { db: ctx.db })

  return server
}
