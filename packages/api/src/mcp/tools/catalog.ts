/**
 * MCP Tools — Organization, group, and tag listing
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import { OrganizationService } from '../../services/organization-service'
import { GroupService } from '../../services/group-service'
import { TagService } from '../../services/tag-service'
import type { AuthUser } from '../../auth/permissions'

interface CatalogToolsContext {
  db: Database
  /** Scopes the dataset counts, matching search_datasets */
  user?: AuthUser
}

export function registerCatalogTools(server: McpServer, ctx: CatalogToolsContext) {
  const { db, user } = ctx

  server.registerTool(
    'list_organizations',
    {
      description: 'List organizations in the data catalog. Organizations own and manage datasets.',
      inputSchema: {
        q: z.string().optional().describe('Search query to filter organizations by name or title'),
        offset: z.number().min(0).default(0).describe('Number of results to skip (for pagination)'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ q, offset, limit }) => {
      const service = new OrganizationService(db)
      const result = await service.list({ q, limit, offset }, user)

      const text =
        result.items.length === 0
          ? 'No organizations found.'
          : result.items
              .map(
                (org, i) =>
                  `${i + 1}. ${org.title || org.name}` +
                  `\n   Name: ${org.name}` +
                  (org.description ? `\n   Description: ${org.description.slice(0, 150)}` : '') +
                  `\n   Datasets: ${(org as Record<string, unknown>).datasetCount ?? 'N/A'}`
              )
              .join('\n\n') + `\n\nTotal: ${result.total} organizations`

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'list_groups',
    {
      description:
        'List topic groups in the data catalog. Groups organize datasets by theme or category.',
      inputSchema: {
        q: z.string().optional().describe('Search query to filter groups by name or title'),
        offset: z.number().min(0).default(0).describe('Number of results to skip (for pagination)'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ q, offset, limit }) => {
      const service = new GroupService(db)
      const result = await service.list({ q, limit, offset }, user)

      const text =
        result.items.length === 0
          ? 'No groups found.'
          : result.items
              .map(
                (g, i) =>
                  `${i + 1}. ${g.title || g.name}` +
                  `\n   Name: ${g.name}` +
                  (g.description ? `\n   Description: ${g.description.slice(0, 150)}` : '') +
                  `\n   Datasets: ${(g as Record<string, unknown>).datasetCount ?? 'N/A'}`
              )
              .join('\n\n') + `\n\nTotal: ${result.total} groups`

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'list_tags',
    {
      description:
        'List tags used in the data catalog. Tags are keywords assigned to datasets for classification.',
      inputSchema: {
        q: z.string().optional().describe('Search query to filter tags by name'),
        offset: z.number().min(0).default(0).describe('Number of results to skip (for pagination)'),
        limit: z.number().min(1).max(200).default(50).describe('Maximum number of results'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ q, offset, limit }) => {
      const service = new TagService(db)
      const result = await service.list({ q, limit, offset }, user)

      const text =
        result.items.length === 0
          ? 'No tags found.'
          : result.items.map((t) => t.name).join(', ') +
            `\n\nTotal: ${result.total} tags (showing ${result.items.length})`

      return { content: [{ type: 'text' as const, text }] }
    }
  )
}
