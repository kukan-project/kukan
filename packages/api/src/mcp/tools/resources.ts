/**
 * MCP Tools — Resource metadata
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import { ResourceService } from '../../services/resource-service'
import { PipelineService } from '../../services/pipeline-service'
import type { AuthUser } from '../../auth/permissions'

interface ResourceToolsContext {
  db: Database
  user?: AuthUser
}

export function registerResourceTools(server: McpServer, ctx: ResourceToolsContext) {
  const { db, user } = ctx

  server.registerTool(
    'get_resource',
    {
      description: 'Get metadata about a specific resource (file) in a dataset.',
      inputSchema: {
        id: z.string().describe('Resource UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const service = new ResourceService(db)
      const res = await service.getByIdWithAccessCheck(id, user)

      const url = res.urlType === 'upload' ? `/api/v1/resources/${res.id}/download` : res.url

      const text = [
        `Name: ${res.name || '(untitled)'}`,
        `ID: ${res.id}`,
        `Package ID: ${res.packageId}`,
        res.description && `Description: ${res.description}`,
        res.format && `Format: ${res.format}`,
        url && `URL: ${url}`,
        `Size: ${res.size != null ? `${res.size} bytes` : 'unknown'}`,
        `Created: ${res.created}`,
        `Updated: ${res.updated}`,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'get_resource_schema',
    {
      description:
        'Get the column schema (field names and inferred types) of a tabular resource (CSV/TSV) so you can write a SQL query against its data. Returns whether the resource is queryable; only CSV/TSV resources within the size limit have a schema.',
      inputSchema: {
        id: z.string().describe('Resource UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const service = new ResourceService(db)
      await service.getByIdWithAccessCheck(id, user)

      const schema = await new PipelineService(db).getSchema(id)
      if (!schema) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Resource ${id} is not queryable: no tabular schema is available (only CSV/TSV resources within the size limit have one).`,
            },
          ],
        }
      }

      const text = [
        `Resource ${id} is queryable.`,
        `Rows: ${schema.rowCount}`,
        `Columns (${schema.columns.length}):`,
        ...schema.columns.map((col) => {
          const range = col.stats ? `, range ${col.stats.min}..${col.stats.max}` : ''
          return `  - ${col.name}: ${col.type}${col.nullable ? ' (nullable)' : ''}${range}`
        }),
      ].join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )
}
