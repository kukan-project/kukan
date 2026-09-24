/**
 * Whether a resource has an OData feed, answered once (ADR-055).
 *
 * The page that offers the URL and the path that serves it have to agree, and
 * they ask from different directions — the feed resolves with no viewer and
 * never sees a private resource at all, while the page is looking at one on
 * behalf of someone who can. A second spelling of the rule is a page promising
 * a URL that 404s, or withholding one that works, and neither shows up as a
 * failure anywhere.
 *
 * Kept out of `edm.ts`, which is about identifiers, types and values and has no
 * business reading the database's shape.
 */

import type { OdataKey, OdataRefusal, OdataRefusalReason, ResourceSchema } from '@kukan/shared'
import type { Database } from '@kukan/db'
import { isQueryable, type QueryTarget } from '../pipeline-service'
import { ResourceVersionService } from '../resource-version-service'
import { buildModel, edmRefusal, odataKeyOf, type EdmModel, type EdmRefusal } from './edm'
import { estimateRowBytes, rowsMayBeTooWide } from './page-budget'

/**
 * Whether this is a reason the table itself gives, rather than its dataset —
 * the refusals a stranger may be told about, because the publisher can act on
 * them. Everything else is "there is no feed here".
 *
 * A page too wide to read is not among them. Only the read can answer that — the
 * estimate this file could ask instead was measured refusing a table that reads
 * (`ODATA_ROW_GROUP_CAUTION_BYTES`) — so `openPage` raises it where it happens.
 */
export function isEdmRefusal(reason: OdataRefusalReason): reason is EdmRefusal {
  return reason === 'unsupported-columns' || reason === 'duplicate-columns'
}

/**
 * Why the feed refuses this table, in one clause each surface frames its own
 * way — the BI client's error body, the agent's line, the publisher's page.
 *
 * Here rather than in either caller because one table refused by two doors
 * should not give two different sentences. The localized wording the web page
 * shows is a separate set on purpose: it needs a locale and a list formatter,
 * neither of which belongs in this package.
 */
export const FEED_REFUSAL_REASON: Record<OdataRefusalReason, string> = {
  'not-queryable': 'this resource has no table to serve',
  'not-public': 'only resources in a public, published dataset are served',
  'unsupported-columns': 'one or more column names are not valid OData identifiers',
  'duplicate-columns': 'two columns share the same name',
}

export function feedRefusal(
  pkg: { private: boolean; state: string | null },
  target: QueryTarget | null
): OdataRefusal | null {
  if (!isQueryable(target)) return { reason: 'not-queryable', columns: [] }
  if (pkg.private || pkg.state !== 'active') return { reason: 'not-public', columns: [] }
  return edmRefusal(target.schema)
}

/**
 * The model this table is served by — the same answer for the page that offers
 * the URL and the path that serves it, for the reason at the top of this file.
 *
 * **The ingest's verdict is read only when the frozen counts cannot answer.**
 * Building the model first says whether they could: every other outcome is
 * settled without the database, and `unverified` is the one — a composite key,
 * or a schema from before the counts — where a version's recorded key is the
 * only thing left to ask. The feed resolves this on every page, so a read that
 * the common case discards is a read a BI tool pays for a few hundred times in
 * one extract.
 */
export async function feedModel(
  db: Database,
  resourceId: string,
  schema: ResourceSchema,
  primaryKey: string[] | null
): Promise<EdmModel> {
  const model = buildModel(schema, primaryKey)
  if (model.keyFallback !== 'unverified') return model
  const verified = await new ResourceVersionService(db).liveLakeKey(resourceId)
  return buildModel(schema, primaryKey, verified)
}

/**
 * Everything a surface has to say about this resource's feed, composed once
 * (ADR-055).
 *
 * Its own function because two callers ask the same four questions in the same
 * order — the resource page through `GET /:id/schema`, and the MCP tool an
 * agent asks before deciding how to fetch the data — and answering them apart
 * is how the two drifted: the page cautioned about a table too wide to read
 * while the tool handed out its URL with nothing said.
 *
 * `not-queryable` is not reported. A resource with no table at all is not a
 * feed's subject, and a surface that named it would be explaining the absence
 * of a thing it never offered.
 */
export interface FeedDescription {
  /** The refusal the publisher can act on, or null when the feed serves this. */
  refusal: OdataRefusal | null
  /** What identifies the rows, or null when nothing is served. */
  key: OdataKey | null
  /** Whether a page of it may fail to read — a caution, never a refusal. */
  wideRows: boolean
}

export async function describeFeed(
  db: Database,
  res: { id: string; size: number | null },
  pkg: { private: boolean; state: string | null },
  target: QueryTarget | null
): Promise<FeedDescription> {
  const refusal = feedRefusal(pkg, target)
  if (refusal || !target?.schema) {
    const reported = refusal && refusal.reason !== 'not-queryable' ? refusal : null
    return { refusal: reported, key: null, wideRows: false }
  }
  // The key is built rather than described: the conditions on one are the
  // feed's (`buildModel`), and a surface restating them tells a publisher their
  // table has no extra column while `$metadata` says it has. The row estimate
  // takes the model for the same reason — a keyless table carries a synthetic
  // key on every row, and a caution measured without it is about a narrower
  // table than the one served.
  const model = await feedModel(db, res.id, target.schema, target.primaryKey)
  const rowBytes = estimateRowBytes(res.size, target.encoding, model)
  return {
    refusal: null,
    key: odataKeyOf(model),
    wideRows: rowsMayBeTooWide(rowBytes, target.rowGroupRows),
  }
}
