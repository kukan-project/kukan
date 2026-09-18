/**
 * MCP Tools — Dataset search and retrieval
 */

import { sectionLayout } from '@kukan/shared'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { MatchedResource, MatchedResourcesCount, SearchAdapter } from '@kukan/search-adapter'
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

/** How many matched files to name before the count speaks for the rest. */
const MAX_NAMED_RESOURCES = 5

/**
 * Which files in a dataset the query actually matched, and on what account.
 *
 * A dataset is the unit of the result and the wrong unit to act on: one holding
 * many files answers the question with one of them, and without this the
 * caller's next move is to fetch the dataset and guess. The reason matters as
 * much as the name — a semantic hit means the query's words appear nowhere in
 * the file, so a caller that goes looking for them will not find them (ADR-054).
 */
export function matchedResourceLines(item: {
  matchedResources?: MatchedResource[]
  matchedResourcesCount?: MatchedResourcesCount
}): string[] {
  const matched = item.matchedResources ?? []
  if (matched.length === 0) return []
  const named = matched.slice(0, MAX_NAMED_RESOURCES).map((r) => {
    const why =
      r.matchSource === 'semantic'
        ? `by meaning${r.similarity !== undefined ? ` ${r.similarity.toFixed(2)}` : ''}`
        : r.matchSource === 'content'
          ? 'in its contents'
          : r.matchedOn?.includes('summary')
            ? 'in its AI-written description'
            : 'in its name or description'
    return `     - ${r.name || '(untitled)'} [${r.format || 'unknown'}] (${why}, ID: ${r.id})`
  })
  // Against the count, not the array: the adapters carry at most
  // MAX_MATCHED_RESOURCES_PER_PACKAGE entries and keep the real total beside
  // them, so subtracting from what was carried under-reports a package that
  // matched past the cap. `atLeast` says the total is itself a floor.
  const count = item.matchedResourcesCount
  const total = Math.max(count?.total ?? matched.length, matched.length)
  const rest = total - named.length
  // A floor can sit below what was carried: a semantic hit added to a capped
  // list leaves the total where it was and marks it `atLeast` rather than
  // raising it on a guess. Then the remainder computes to none, and saying
  // nothing would present the named ones as the whole of it.
  const more =
    rest > 0
      ? count?.atLeast
        ? `at least ${rest} more`
        : `${rest} more`
      : count?.atLeast
        ? 'possibly more'
        : null
  return [`   Matched files:`, ...named, ...(more ? [`     …and ${more}`] : [])]
}

export function registerDatasetTools(server: McpServer, ctx: DatasetToolsContext) {
  const { db, user } = ctx

  server.registerTool(
    'search_datasets',
    {
      description:
        'Search datasets in the data catalog by keyword. Returns matching datasets with title, description, organization, and available formats, and — where a dataset holds several files — which of them matched and on what account (its name, its contents, its AI-written description, or its meaning). Results may include semantically related datasets beyond exact keyword matches.',
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
                  ...matchedResourceLines(item),
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

      // The public page's headings, one per level, with the resources a level deeper (ADR-050)
      const rows = result.resources ?? []
      const resources =
        sectionLayout(rows)
          .flatMap(({ depth, headings }, i) => [
            ...headings.map((h) => `${'  '.repeat(h.depth)}[${h.label}]`),
            `${'  '.repeat(depth + 1)}${i + 1}. ${rows[i].name || '(untitled)'}` +
              ` (ID: ${rows[i].id})` +
              (rows[i].format ? ` [${rows[i].format}]` : '') +
              (rows[i].description ? ` — ${rows[i].description.slice(0, 100)}` : ''),
          ])
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
