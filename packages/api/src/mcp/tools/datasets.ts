/**
 * MCP Tools — Dataset search and retrieval
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { SearchAdapter } from '@kukan/search-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { PackageService } from '../../services/package-service'
import { hybridSearch } from '../../services/hybrid-search'
import { resolveUserOrgIds, buildVisibilityFilters, type AuthUser } from '../../auth/permissions'

interface DatasetToolsContext {
  db: Database
  search: SearchAdapter
  /** PostgreSQL adapter carrying the vectors (hybrid search, ADR-034) */
  dbSearch: SearchAdapter
  ai: AIAdapter
  logger: Logger
  user?: AuthUser
}

export function registerDatasetTools(server: McpServer, ctx: DatasetToolsContext) {
  const { db, user } = ctx

  server.registerTool(
    'search_datasets',
    {
      description:
        'Search datasets in the data catalog by keyword. Returns matching datasets with title, description, organization, and available formats. Results may include semantically related datasets beyond exact keyword matches.',
      inputSchema: {
        q: z.string().describe('Search query keywords'),
        organization: z.string().optional().describe('Filter by organization name (slug)'),
        tags: z.array(z.string()).optional().describe('Filter by tag names'),
        offset: z.number().min(0).default(0).describe('Number of results to skip (for pagination)'),
        limit: z.number().min(1).max(50).default(10).describe('Maximum number of results'),
        semantic: z
          .boolean()
          .default(true)
          .describe('Set false for exact keyword matching only (no semantically related results)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ q, organization, tags, offset, limit, semantic }) => {
      const userOrgIds = await resolveUserOrgIds(db, user)
      const visibility = buildVisibilityFilters(user, userOrgIds)

      const result = await hybridSearch(ctx, {
        q,
        offset,
        limit,
        semantic,
        filters: {
          ...(organization && { organizations: [organization] }),
          ...(tags?.length && { tags }),
          ...visibility,
        },
      })

      const text =
        result.items.length === 0
          ? `No datasets found for "${q}".`
          : result.items
              .map((item, i) => {
                const org = item.organization || ''
                const formats = item.formats?.join(', ') || ''
                return [
                  `${i + 1}. ${item.title || item.name}`,
                  `   Name: ${item.name}`,
                  org && `   Organization: ${org}`,
                  item.notes && `   Description: ${item.notes.slice(0, 200)}`,
                  formats && `   Formats: ${formats}`,
                ]
                  .filter(Boolean)
                  .join('\n')
              })
              .join('\n\n') +
            `\n\nTotal: ${result.total} datasets found (showing ${result.items.length})`

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'get_dataset',
    {
      description:
        'Get detailed information about a specific dataset, including all its resources.',
      inputSchema: {
        nameOrId: z.string().describe('Dataset name (slug) or UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ nameOrId }) => {
      const service = new PackageService(db)
      const result = await service.getDetailByNameOrId(nameOrId, user)

      const resources =
        result.resources
          ?.map(
            (r, i) =>
              `  ${i + 1}. ${r.name || '(untitled)'}` +
              ` (ID: ${r.id})` +
              (r.format ? ` [${r.format}]` : '') +
              (r.description ? ` — ${r.description.slice(0, 100)}` : '')
          )
          .join('\n') || '  (none)'

      const tags = result.tags?.map((t) => t.name).join(', ') || ''
      const groups = result.groups?.map((g) => g.title || g.name).join(', ') || ''

      const text = [
        `Title: ${result.title || result.name}`,
        `Name: ${result.name}`,
        `ID: ${result.id}`,
        result.organization &&
          `Organization: ${result.organization.title || result.organization.name}`,
        result.notes && `Description: ${result.notes}`,
        tags && `Tags: ${tags}`,
        groups && `Groups: ${groups}`,
        result.private !== undefined && `Private: ${result.private}`,
        `Created: ${result.created}`,
        `Updated: ${result.updated}`,
        `\nResources:\n${resources}`,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )
}
