/**
 * MCP Tools — Resource metadata
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { primaryKeyOf, feedServiceRoot, ODATA_ENTITY_SET } from '@kukan/shared'
import type { Env, OdataKeyFallback, OdataRefusal } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { AIAdapter } from '@kukan/ai-adapter'
import { ResourceService, resourceDownloadPath } from '../../services/resource-service'
import { PipelineService, isQueryable } from '../../services/pipeline-service'
import {
  describeFeed,
  FEED_REFUSAL_REASON,
  type FeedDescription,
} from '../../services/odata/feed-eligibility'
import { summaryLines } from './summary-text'
import { getSummaryModel } from '../../services/suggest/availability'
import type { AuthUser } from '../../auth/permissions'

interface ResourceToolsContext {
  db: Database
  user?: AuthUser
  /** The two the abstract's switch is made of (ADR-053 §6.1): the named model
   *  is environment, and whether the provider can be reached is the adapter's */
  env: Env
  ai: AIAdapter
}

/**
 * Why the feed added a column of its own, in the publisher's terms.
 *
 * Each reason is a different next step — declare a key, fix the values, wait
 * for the ingest — which is why the contract keeps them apart rather than
 * collapsing them to "no key" ({@link OdataKey}). An agent is the consumer most
 * able to act on the difference, so it gets all of them.
 */
const KEY_FALLBACK_REASON: Record<OdataKeyFallback, string> = {
  'not-designated': 'no primary key is declared for this resource',
  'key-missing': 'the declared primary key is not a column of the current table',
  'key-null': 'the declared primary key has empty values',
  'key-not-unique': 'the declared primary key repeats values',
  'key-float': 'the declared primary key is a floating-point column, which cannot identify a row',
  'unsafe-integers':
    'the declared primary key holds integers too large to survive a client that reads them as doubles',
  unverified:
    'the declared composite key is verified when the version is ingested, which has not happened yet',
}

/**
 * The feed's URL and what identifies its rows — or why there is none.
 *
 * Rendered from {@link describeFeed}, the same answer the resource page shows,
 * so an agent is never handed a URL that 404s nor told there is none when there
 * is one.
 */
function odataLines(env: Env, id: string, feed: FeedDescription): string[] {
  // Nothing at all where there is no refusal to report: the resource has no
  // table a feed could be about, which the queryable line above has said
  // already, and the resource page says nothing here for the same reason.
  if (feed.key === null) {
    return feed.refusal ? [`OData: not served — ${refusalSentence(feed.refusal)}`] : []
  }
  return [
    `OData feed: ${feedServiceRoot(env, id)}/${ODATA_ENTITY_SET}`,
    feed.key.fallback
      ? `  Rows carry an added \`${feed.key.names.join(', ')}\` column, because ${KEY_FALLBACK_REASON[feed.key.fallback]}.`
      : `  Rows are identified by ${feed.key.names.join(', ')}; no column is added.`,
    // The caution the resource page gives a publisher, which an agent needs for
    // the same reason: a read that will not fit arrives as a 501 part-way
    // through an extract, not as a refusal up front (ADR-055 §6).
    ...(feed.wideRows
      ? [
          '  This table has large rows; a page of it may fail to read. Download the file if it does.',
        ]
      : []),
  ]
}

/** The shared clause, with the headings at fault where there are any. */
function refusalSentence(refusal: OdataRefusal): string {
  const base = FEED_REFUSAL_REASON[refusal.reason]
  return refusal.columns.length > 0 ? `${base}: ${refusal.columns.join(', ')}` : base
}

export function registerResourceTools(server: McpServer, ctx: ResourceToolsContext) {
  const { db, user, env, ai } = ctx
  // One question for the whole registration: the switch is deployment-wide
  const summariesEnabled = getSummaryModel(env, ai) !== null

  server.registerTool(
    'get_resource',
    {
      description:
        'Get metadata about a specific resource (file) in a dataset. Where the site generates them, the response also carries an AI-written description of the file, how much of the file it was written from, and which version it describes.',
      inputSchema: {
        id: z.string().describe('Resource UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const service = new ResourceService(db)
      const res = await service.getByIdWithAccessCheck(id, user)

      const url = res.urlType === 'upload' ? resourceDownloadPath(res.id) : res.url

      const text = [
        `Name: ${res.name || '(untitled)'}`,
        `ID: ${res.id}`,
        `Package ID: ${res.packageId}`,
        res.section && `Section: ${res.section}`,
        res.description && `Description: ${res.description}`,
        res.format && `Format: ${res.format}`,
        url && `URL: ${url}`,
        `Size: ${res.size != null ? `${res.size} bytes` : 'unknown'}`,
        `Created: ${res.created}`,
        `Updated: ${res.updated}`,
        // The abstract last, because it is the long field and everything above
        // it is what a caller matches on (ADR-053)
        ...summaryLines(res.summary, res.summaryMeta, res.latestVersion, summariesEnabled),
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
        'Get the column schema (field names and inferred types) of a tabular resource (CSV/TSV) so you can write a SQL query against its data. Returns whether the resource is queryable, and whether its rows are also readable over OData; only CSV/TSV resources within the size limit have a schema.',
      inputSchema: {
        id: z.string().describe('Resource UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const service = new ResourceService(db)
      // The parent's ownership too, because whether the feed serves this table
      // turns on it (ADR-055 §5) and the visibility check has read it already.
      const { resource: res, pkg } = await service.getByIdWithOwnership(id, user)

      const target = await new PipelineService(db).getQueryTarget(id)
      if (!target?.schema || target.schema.columns.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Resource ${id} is not queryable: no tabular schema is available (only processed CSV/TSV resources within the size limit have one).`,
            },
          ],
        }
      }
      const schema = target.schema

      // Same predicate as POST /:id/query — never tell an agent a resource is
      // queryable when the follow-up query_resource call would only 400. The
      // columns are still worth showing (same contract as GET /:id/schema);
      // only the query guidance is withheld.
      const queryable = isQueryable(target)

      // The same fact GET /:id/schema serves (the spec treats the two as one
      // surface) — and a keyed query is exactly what an agent wants it for.
      const primaryKey = primaryKeyOf(res.columnSettings)

      // Whether the rows are also readable over OData (ADR-055) — the same
      // answer the resource page shows, composed once so the two cannot drift.
      //
      // `queryable` does not imply it: a table whose headings are not OData
      // identifiers, or that has two columns of one name, is refused by the feed
      // and served by SQL. An agent deciding how to fetch the data needs both.
      const feed = await describeFeed(db, { id, size: res.size }, pkg, target)
      const firstCol = schema.columns[0]?.name ?? 'column'
      const text = [
        queryable
          ? `Resource ${id} is queryable.`
          : `Resource ${id} is not currently queryable (its preview data is unavailable or does not reflect the current content). Schema shown for reference only.`,
        `Rows: ${schema.rowCount}`,
        ...(primaryKey ? [`Primary key: ${primaryKey.join(', ')}`] : []),
        ...odataLines(env, id, feed),
        `Columns (${schema.columns.length}):`,
        ...schema.columns.map((col) => {
          const range = col.stats ? `, range ${col.stats.min}..${col.stats.max}` : ''
          return `  - ${col.name}: ${col.type}${col.nullable ? ' (nullable)' : ''}${range}`
        }),
        ...(queryable
          ? [
              '',
              'To query the data, call query_resource with DuckDB SQL over a table named `data`.',
              'Only a single read-only SELECT/WITH statement is allowed. Double-quote column',
              'names that contain spaces or non-ASCII characters. Use aggregations or LIMIT —',
              'large result sets are truncated.',
              `Example: SELECT "${firstCol}", count(*) AS n FROM data GROUP BY "${firstCol}" ORDER BY n DESC LIMIT 20`,
            ]
          : []),
      ].join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )
}
