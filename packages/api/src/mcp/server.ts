/**
 * KUKAN MCP Server
 * Creates and configures the MCP server with all tools registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { registerDatasetTools } from './tools/datasets'
import { registerResourceTools } from './tools/resources'
import { registerCatalogTools } from './tools/catalog'
import { registerQueryTools } from './tools/query'

interface McpContext {
  db: Database
  search: SearchAdapter
  /** PostgreSQL adapter carrying the vectors (hybrid search, ADR-034) */
  dbSearch: SearchAdapter
  storage: StorageAdapter
  ai: AIAdapter
  logger: Logger
  user?: { id: string; sysadmin: boolean }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({
    name: 'kukan',
    version: '1.0.0',
  })

  registerDatasetTools(server, ctx)
  registerResourceTools(server, { db: ctx.db, user: ctx.user })
  registerCatalogTools(server, { db: ctx.db, user: ctx.user })
  registerQueryTools(server, { db: ctx.db, storage: ctx.storage, user: ctx.user })

  return server
}
