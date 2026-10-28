/**
 * KUKAN MCP Server
 * Creates and configures the MCP server with all tools registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { MeteredAI } from '@kukan/ai-adapter'
import type { Env, Logger } from '@kukan/shared'
import type { SystemSettingService } from '../services/system-setting'
import { registerDatasetTools } from './tools/datasets'
import { registerResourceTools } from './tools/resources'
import { registerCatalogTools } from './tools/catalog'
import { registerQueryTools } from './tools/query'
import { registerDocumentTools } from './tools/documents'
import { mcpInstructions } from './instructions'
import type { CatalogLanguage } from '../services/catalog-language'

/**
 * The version `initialize` reports in `serverInfo`: the MCP surface's, not the
 * release's. It moves when the tools change — a major for a tool removed or a
 * result reshaped, a minor for one added — and stays put across releases that
 * leave them alone, so a client can tell what it is talking to while an
 * unauthenticated caller learns nothing about which release a site runs
 * (ADR-070).
 */
export const MCP_SERVER_VERSION = '1.0.0'

interface McpContext {
  db: Database
  search: SearchAdapter
  /** PostgreSQL adapter carrying the vectors (hybrid search, ADR-034) */
  dbSearch: SearchAdapter
  storage: StorageAdapter
  ai: MeteredAI
  env: Env
  logger: Logger
  /** Runtime settings the hybrid search reads (ADR-036) */
  settings?: SystemSettingService
  user?: { id: string; sysadmin: boolean }
}

export function createMcpServer(ctx: McpContext, language: CatalogLanguage | null): McpServer {
  const server = new McpServer(
    { name: 'kukan', version: MCP_SERVER_VERSION },
    { instructions: mcpInstructions(language) }
  )

  registerDatasetTools(server, ctx)
  registerResourceTools(server, { db: ctx.db, user: ctx.user, env: ctx.env, ai: ctx.ai })
  registerCatalogTools(server, { db: ctx.db, user: ctx.user })
  registerQueryTools(server, { db: ctx.db, storage: ctx.storage, user: ctx.user })
  registerDocumentTools(server, ctx)

  return server
}
