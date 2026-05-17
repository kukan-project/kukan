/**
 * MCP Tools — Resource metadata
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import { NotFoundError } from '@kukan/shared'
import { ResourceService } from '../../services/resource-service'
import { PackageService } from '../../services/package-service'
import { resolveUserOrgIds } from '../../auth/permissions'

interface ResourceToolsContext {
  db: Database
  user?: Parameters<typeof resolveUserOrgIds>[1]
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
      const res = await service.getById(id)

      // Verify the caller can access the parent dataset.
      // Re-throw NotFoundError as NotFoundError('Resource', id) to avoid leaking package UUID.
      const pkgService = new PackageService(db)
      const viewer = user ? { userId: user.id, sysadmin: user.sysadmin } : undefined
      try {
        await pkgService.getByNameOrIdWithAccessCheck(res.packageId, viewer)
      } catch (err) {
        if (err instanceof NotFoundError) throw new NotFoundError('Resource', id)
        throw err
      }

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
}
