/**
 * MCP Tools — Resource data query (ADR-032 Part B)
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AuthUser } from '../../auth/permissions'
import { QueryService } from '../../services/query-service'

interface QueryToolsContext {
  db: Database
  storage: StorageAdapter
  user?: AuthUser
}

/** Render query results as a Markdown table (cells escaped for `|` and newlines). */
function toMarkdownTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0) return '(no columns)'
  const esc = (v: unknown) =>
    String(v ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
  const header = `| ${columns.join(' | ')} |`
  const sep = `| ${columns.map(() => '---').join(' | ')} |`
  if (rows.length === 0) return [header, sep].join('\n')
  const body = rows.map((r) => `| ${columns.map((c) => esc(r[c])).join(' | ')} |`).join('\n')
  return [header, sep, body].join('\n')
}

export function registerQueryTools(server: McpServer, ctx: QueryToolsContext) {
  const { db, storage, user } = ctx

  server.registerTool(
    'query_resource',
    {
      description:
        'Run a read-only SQL query against a tabular resource (CSV/TSV). The data is exposed as ' +
        'a table named `data`. Call get_resource_schema first to learn the column names/types. ' +
        'Dialect is DuckDB SQL; only a single SELECT or WITH statement is allowed. Double-quote ' +
        'column names containing spaces or non-ASCII characters (e.g. "Prefecture Name"). Prefer ' +
        'aggregations or LIMIT — large results are truncated. Returns a Markdown table.',
      inputSchema: {
        id: z.string().describe('Resource UUID'),
        sql: z
          .string()
          .describe(
            'A single read-only DuckDB SELECT/WITH query over the table `data`, ' +
              'e.g. SELECT "col", count(*) FROM data GROUP BY "col" ORDER BY 2 DESC LIMIT 20'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, sql }) => {
      const result = await new QueryService(db, storage).query(id, sql, user)
      const table = toMarkdownTable(result.columns, result.rows)
      const note = result.truncated
        ? `\n\n_Showing the first ${result.rowCount} rows (truncated)._`
        : `\n\n_${result.rowCount} row(s)._`
      return { content: [{ type: 'text' as const, text: table + note }] }
    }
  )
}
