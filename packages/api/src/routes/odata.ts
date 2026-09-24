/**
 * KUKAN OData v4 routes (ADR-055, Step 1)
 *
 * A read-only feed per resource, so a BI tool can open a table by pasting a
 * URL — the one route Tableau, Power BI and Excel all take without installing
 * anything (ADR-055 §1):
 *
 *   GET /odata/v1/resources/{id}            service document
 *   GET /odata/v1/resources/{id}/$metadata  CSDL (column names and types)
 *   GET /odata/v1/resources/{id}/Rows       the table, paged
 *
 * Mounted outside `/api` and ahead of the auth middleware: this path has no
 * session, no cookie and no CSRF to resolve, because it serves public
 * resources only (ADR-055 §5 / §6). Everything it answers is derived from the
 * schema ADR-032 persisted plus a page of the preview Parquet.
 */

import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import { createHash } from 'node:crypto'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  KukanError,
  NotFoundError,
  RequestTimeoutError,
  isUuid,
  ValidationError,
  PINNED_PAGE_MAX_AGE_S,
  ODATA_ENTITY_SET,
  feedServiceRoot,
} from '@kukan/shared'
import { publicCache } from '../middleware/cache-control'
import { OdataService, type OdataFeed } from '../services/odata/odata-service'
import { FEED_REFUSAL_REASON } from '../services/odata/feed-eligibility'
import { buildMetadataXml, toEdmValue, type EdmModel } from '../services/odata/edm'
import type { EdmRefusal } from '../services/odata/edm'
import { ODATA_FLUSH_BYTES, ODATA_MAX_PAGE_BYTES, ODATA_WRITE_TIMEOUT_MS } from '../config'
import type { AppContext } from '../context'

/** The media type every JSON answer here carries. */
const ODATA_JSON = 'application/json;odata.metadata=minimal;charset=utf-8'

export const odataRouter = new Hono<{ Variables: AppContext }>()

/** OData error payload (OData JSON 4.01 §19); BI clients surface `message`. */
function odataError(code: string, message: string) {
  return { error: { code, message } }
}

/** The shared clause, framed for a BI client's error box. */
function refusalMessage(reason: EdmRefusal): string {
  return `This table cannot be served as OData: ${FEED_REFUSAL_REASON[reason]}`
}

/** Query options that change which rows or values come back, and which this
 *  feed does not apply. Answering them with the whole table would be a wrong
 *  answer rather than a missing feature. */
const SHAPING_OPTIONS = ['$filter', '$orderby', '$apply', '$search', '$expand'] as const

/**
 * Refuse a shaping option rather than ignoring it.
 *
 * A client that pushed a filter down and got the unfiltered table back would
 * show the wrong numbers with nothing anywhere to say so (ADR-055 open item 7
 * decides how much to support). `$select` is not here — extra columns are
 * waste, not a wrong answer, and Tableau's connector cannot send it in the
 * first place.
 *
 * Called by `$count` as well as by the rows: a count is an answer about which
 * rows there are, so a filter refused on one path and dropped on the other is
 * the same wrong number arriving by the shorter route.
 */
function refuseShaping(c: Context<{ Variables: AppContext }>): void {
  const unsupported = SHAPING_OPTIONS.find((opt) => c.req.query(opt) !== undefined)
  if (unsupported) {
    throw new KukanError(`${unsupported} is not supported by this feed`, 'NOT_IMPLEMENTED', 501)
  }
}

/**
 * A non-negative integer query option, or null when absent; NaN when invalid.
 *
 * The safe-integer bound is not pedantry: past it `Number` returns a float
 * whose decimal form is exponential, and `OFFSET 1e+22` is a syntax error the
 * client would receive as a 500.
 */
function intOption(raw: string | undefined): number | null {
  if (raw === undefined) return null
  if (!/^\d+$/.test(raw)) return NaN
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : NaN
}

/**
 * Serve an OData response: version header, and the JSON media type clients
 * negotiate on.
 */
function odataJson(c: Context<{ Variables: AppContext }>, body: unknown) {
  c.header('Content-Type', ODATA_JSON)
  return c.body(JSON.stringify(body))
}

/**
 * Short name for the bytes and the reading a page came from, carried on the
 * next link.
 *
 * **What pins an extract to one interpretation.** Not to a version (ADR-043):
 * re-reading unchanged bytes makes a new preview, and designating a primary
 * key changes the shape of every row, neither of which moves the version. The
 * feed URL names whatever is current, so without this a table re-read
 * mid-extract would hand the client page 1 from one reading and page 2 from
 * the next — and since rows are identified by position, the join of those
 * pages is neither, with nothing in the response to say so.
 */
function interpretationFingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url').slice(0, 12)
}

/**
 * Weak validator over what the response is derived from: the resource's bytes
 * and the exact request. **Computed without reading the data** — the point is
 * that CloudFront's revalidation after a TTL costs a database read rather than
 * a Parquet download and a rebuilt page (ADR-055 §6).
 */
function etagFor(seed: string, path: string, query: string): string {
  const digest = createHash('sha256').update(`${seed}\n${path}\n${query}`).digest('base64url')
  return `W/"${digest.slice(0, 22)}"`
}

/** 304 when the client (or CloudFront) already holds this exact response. */
function notModified(c: Context<{ Variables: AppContext }>, etag: string): boolean {
  c.header('ETag', etag)
  const ifNoneMatch = c.req.header('if-none-match')
  return ifNoneMatch !== undefined && ifNoneMatch.split(',').some((v) => v.trim() === etag)
}

/** The one service a request needs; built per request, as its callers are. */
function odataService(c: Context<{ Variables: AppContext }>): OdataService {
  return new OdataService(c.get('db'), c.get('storage'), c.get('env'), c.get('logger'))
}

/**
 * Resolve the feed, or throw the refusal, so each handler is left with the
 * happy path.
 */
async function resolveFeed(
  service: OdataService,
  id: string
): Promise<Extract<OdataFeed, { ok: true }>> {
  const feed = await service.resolve(id)
  if (feed.ok) return feed
  if (feed.reason === 'not-found') {
    throw new NotFoundError('OData feed', id)
  }
  // The table exists and is public; it is this server that cannot express it
  // yet (ADR-055 Step 2), which is a 501 rather than a 404.
  throw new KukanError(refusalMessage(feed.reason), 'NOT_IMPLEMENTED', 501)
}

/**
 * Wrap a handler so its refusals reach the client in OData's shape rather than
 * the API's RFC 7807 — a mounted router's own `onError` is never consulted, and
 * middleware cannot catch what the composed chain has already handed to the
 * app's error handler. Anything that is not a {@link KukanError} is left to
 * that handler: an unexpected 500 is not this format's business.
 */
function odataHandler(
  fn: (c: Context<{ Variables: AppContext }>, id: string) => Promise<Response>
): (c: Context<{ Variables: AppContext }>) => Promise<Response> {
  return async (c) => {
    // A feed is for machines with a URL, not for a crawler that found one: a
    // search engine walking the next links would download the Parquet once per
    // page for nothing.
    c.header('X-Robots-Tag', 'noindex')
    // Every response this router writes is an OData one, refusals included
    c.header('OData-Version', '4.0')
    try {
      // Every route here is `/:id/…`, so the resource id is resolved once here.
      // Not a UUID is not a resource: answered here, because PostgreSQL would
      // otherwise reject the cast and a stray or scanned URL on this public,
      // unauthenticated path would log as an unexpected server error.
      const id = c.req.param('id') ?? ''
      if (!isUuid(id)) throw new NotFoundError('OData feed', id)
      return await fn(c, id)
    } catch (err) {
      if (err instanceof KukanError) {
        // A handler may already have marked the response cacheable before the
        // failure — a refusal must never inherit that.
        c.header('Cache-Control', 'private, no-cache')
        // A refusal for want of a slot is temporary, and says so: a page holds
        // one for at most ODATA_WRITE_TIMEOUT_MS and usually for a fraction of
        // a second, so the wait is a back-off rather than a bound.
        if (err.status === 429) c.header('Retry-After', '5')
        return c.json(odataError(err.code, err.message), err.status as ContentfulStatusCode)
      }
      throw err
    }
  }
}

// GET /odata/v1/resources/:id — service document (what Tableau's "Server" field
// accepts; the individual feed URL below works there too).
//
// The one response that may be held: it names the entity set and nothing about
// the table, so a copy a minute old is the same bytes as a fresh one.
const serviceDocument = odataHandler(async (c, id) => {
  const feed = await resolveFeed(odataService(c), id)
  const root = feedServiceRoot(c.get('env'), id)
  if (notModified(c, etagFor(feed.etagSeed, 'service', ''))) return c.body(null, 304)
  return odataJson(c, {
    '@odata.context': `${root}/$metadata`,
    value: [{ name: ODATA_ENTITY_SET, kind: 'EntitySet', url: ODATA_ENTITY_SET }],
  })
})

// Registered twice because Hono matches strictly, and a service root is the one
// URL a person pastes by hand: OData writes it with the trailing slash (the
// spec's own examples do), and Tableau's Server field passes on whatever was
// typed. Without this, one keystroke is the difference between a feed and a 404.
odataRouter.get('/:id', publicCache(), serviceDocument)
odataRouter.get('/:id/', publicCache(), serviceDocument)

// GET /odata/v1/resources/:id/$metadata — CSDL, in XML as the format requires
odataRouter.get(
  '/:id/$metadata',
  odataHandler(async (c, id) => {
    const feed = await resolveFeed(odataService(c), id)
    // **Revalidated every time, unlike the rest of the feed.** This document
    // declares the columns the rows are read under, and a client holds it for
    // the whole extract — so a copy 60 seconds stale is a client combining an
    // old CSDL with new rows, which nothing in the response would reveal. The
    // validator answers without reading the data, so a revalidation costs a
    // database read rather than a page. (A window of a request remains: the
    // schema can change between this and the first page. The fingerprint on
    // the next links closes it for everything after that.)
    c.header('Cache-Control', 'public, no-cache')
    if (notModified(c, etagFor(feed.etagSeed, 'metadata', ''))) return c.body(null, 304)
    c.header('Content-Type', 'application/xml;charset=utf-8')
    return c.body(buildMetadataXml(feed.model))
  })
)

// GET /odata/v1/resources/:id/Rows/$count — row count as plain text
odataRouter.get(
  `/:id/${ODATA_ENTITY_SET}/$count`,
  odataHandler(async (c, id) => {
    refuseShaping(c)
    const feed = await resolveFeed(odataService(c), id)
    // A count is the table's, so it names no interpretation and revalidates
    // like the rest of them: held for a minute it is the old table's number
    // beside the new table's rows, which is the pairing this feed refuses.
    c.header('Cache-Control', 'public, no-cache')
    if (notModified(c, etagFor(feed.etagSeed, 'count', ''))) return c.body(null, 304)
    c.header('Content-Type', 'text/plain;charset=utf-8')
    return c.body(String(feed.model.rowCount))
  })
)

// GET /odata/v1/resources/:id/Rows — the table itself, paged.
// No `publicCache()`: this route decides its own age, which depends on whether
// the page names the interpretation it came from.
odataRouter.get(
  `/:id/${ODATA_ENTITY_SET}`,
  odataHandler(async (c, id) => {
    const top = intOption(c.req.query('$top'))
    const skip = intOption(c.req.query('$skip'))
    if (Number.isNaN(top) || Number.isNaN(skip)) {
      throw new ValidationError(
        '$top and $skip must be non-negative integers within the safe range'
      )
    }
    refuseShaping(c)

    const service = odataService(c)
    const feed = await resolveFeed(service, id)
    const root = feedServiceRoot(c.get('env'), id)
    const query = new URL(c.req.url).search

    // A page of a reading that is no longer current cannot be served: what the
    // client holds and what this page would carry are different tables. Loud,
    // because the alternative is a client quietly assembling both halves.
    const fingerprint = interpretationFingerprint(feed.etagSeed)
    const pinned = c.req.query('v')
    if (pinned !== undefined && pinned !== fingerprint) {
      throw new KukanError(
        'The data changed while this extract was running; start again from the feed URL',
        'GONE',
        410
      )
    }
    // A page that names its interpretation describes bytes that cannot change
    // under it, and one that does not is only as good as what is current.
    //
    // **What bounds the pinned one is withdrawal, not change** — the dataset
    // made private, the resource deleted, or the version being served purged.
    // The origin refuses from that moment; a copy the edge holds does not, and
    // no pin helps, because a cached page never reaches the origin to be told.
    // Hence minutes rather than the day the bytes' immutability would justify,
    // and revalidatable rather than `immutable` (see PINNED_PAGE_MAX_AGE_S).
    //
    // **A page with no version in it revalidates**, like `$metadata` and for
    // the same pairing: held for a minute, it is an old table beside the
    // current declaration of its columns, and a table of one page never
    // reaches a next link to find out. Pinning the first page instead — a
    // redirect into a versioned URL — would close the same window, but a BI
    // tool that saves the URL it resolved would then meet a 410 on the next
    // refresh after any re-interpretation, which trades a narrow window for a
    // broken refresh. What is left is one request's worth of race, between
    // this page and the `$metadata` beside it.
    c.header(
      'Cache-Control',
      pinned === fingerprint ? `public, max-age=${PINNED_PAGE_MAX_AGE_S}` : 'public, no-cache'
    )
    if (notModified(c, etagFor(feed.etagSeed, 'rows', query))) return c.body(null, 304)

    const offset = skip ?? 0
    // What a page may cost is the service's to decide (ADR-055 §6); what the
    // client asked for is all this passes in, and `page.limit` reports back the
    // number used, which is what `delivered` compares against for the next link.
    //
    // Opened before a byte of the response is written, so a download or query
    // failure is still a status code rather than a body that stops mid-array.
    const page =
      top === 0
        ? null
        : await service.openPage(feed, { skip: offset, limit: top, signal: c.req.raw.signal })

    c.header('Content-Type', ODATA_JSON)
    // One timer for the whole response rather than one per write. A caller that
    // stops reading blocks inside `write` on back-pressure, where no check of
    // ours would ever run, so the deadline has to be raced against it — and
    // losing that race is what frees the slot (config §ODATA_WRITE_TIMEOUT_MS).
    let expire!: NodeJS.Timeout
    const expired = new Promise<never>((_, reject) => {
      expire = setTimeout(
        () => reject(new RequestTimeoutError('Page write timed out')),
        ODATA_WRITE_TIMEOUT_MS
      )
    })
    expired.catch(() => {}) // raced rather than awaited, so never unhandled

    return stream(
      c,
      async (s) => {
        // Buffered to a flush size rather than written per row. Each `write` is
        // an encode and a race against the deadline, and the race subscribes a
        // reaction to a promise that does not settle until the page ends — per
        // row that measured 15 MB retained and 146 ms on a 50,000-row page,
        // against 13 ms and nothing retained when the rows go out in blocks.
        let pending = ''
        let pendingBytes = 0
        const flush = async () => {
          if (!pending) return
          const chunk = pending
          pending = ''
          pendingBytes = 0
          await Promise.race([s.write(chunk), expired])
        }
        // Accumulation is synchronous and only a flush is awaited: a row that
        // adds to the buffer should not cost a promise and a microtask, and
        // ~99% of rows do exactly that. Bytes rather than string length,
        // because Japanese is one UTF-16 unit and three bytes — measured the
        // other way, a flush is three times the size it reads as.
        const push = (chunk: string, bytes = Buffer.byteLength(chunk)) => {
          pending += chunk
          pendingBytes += bytes
        }
        const write = async (chunk: string) => {
          push(chunk)
          if (pendingBytes >= ODATA_FLUSH_BYTES) await flush()
        }
        try {
          await write(
            `{"@odata.context":${JSON.stringify(`${root}/$metadata#${ODATA_ENTITY_SET}`)}`
          )
          // Before `value`, where the format wants it; the next link can only be
          // known once the rows have gone out, so it goes after (OData JSON 4.01
          // §4.5.1 — which is how a feed streams at all).
          if (c.req.query('$count') === 'true') {
            await write(`,"@odata.count":${feed.model.rowCount}`)
          }
          await write(',"value":[')

          let delivered = 0
          let bytes = 0
          let hitCap = false
          if (page) {
            // One entity object for the page, overwritten per row. Its keys are
            // set once in order, so every row serializes identically to a fresh
            // object — and building a fresh one per row measured 44 ms against
            // 34 over a 5,400-row page of 56 columns.
            const entity = emptyEntity(feed.model)
            const positions = columnPositions(feed.model, page.columns)
            const { columns, syntheticKey } = feed.model
            for await (const chunk of page.chunks()) {
              // **A caller that has gone must not keep the slot.** Hono swallows
              // a write to a cancelled stream, so `flush` goes on resolving and
              // nothing below would notice: the page would be read and
              // serialized to its limit for nobody, holding one of the feed's
              // few slots. Leaving the loop closes the page (`finally`).
              if (s.aborted) break
              for (const values of chunk) {
                fillEntity(entity, values, columns, positions, syntheticKey, offset + delivered)
                const json = JSON.stringify(entity)
                const size = Buffer.byteLength(json)
                // The row that would cross the budget starts the next page
                // instead. Never the first one, though: a page of no rows would
                // point at itself and the client would fetch it for ever.
                if (delivered > 0 && bytes + size > ODATA_MAX_PAGE_BYTES) {
                  hitCap = true
                  break
                }
                push(delivered > 0 ? `,${json}` : json, size + 1)
                bytes += size + 1
                delivered++
                if (pendingBytes >= ODATA_FLUSH_BYTES) await flush()
              }
              if (hitCap) break
            }
          }
          if (s.aborted) return
          await write(']')

          // A partial answer always says where the rest is, `$top` included: a
          // client that asked for more than a page would otherwise take the page
          // for the whole table, with nothing in the response to say otherwise.
          // What it asked for rides along, minus what it just got.
          //
          // A page cut for size is unambiguous — the row it stopped at was read,
          // so it exists — while a full page is only known to have more behind it
          // from the row count the schema carries. Trusting that count alone
          // would loop for ever on a table whose count reads high.
          const remaining = top === null ? null : top - delivered
          // `$top=0` opens no page at all, and has nothing behind it to link to.
          const more =
            hitCap || (delivered === page?.limit && offset + delivered < feed.model.rowCount)
          if (more && remaining !== 0) {
            const carry = remaining === null ? '' : `&$top=${remaining}`
            // The version rides along, so the rest of this extract is either
            // the same table or an error, never a silent mixture.
            const next = `${root}/${ODATA_ENTITY_SET}?$skip=${offset + delivered}${carry}&v=${fingerprint}`
            await write(`,"@odata.nextLink":${JSON.stringify(next)}`)
          }
          await write('}')
          await flush()
        } finally {
          clearTimeout(expire)
          await page?.close()
        }
      },
      // Hono console.errors an unhandled streaming failure; a caller that stopped
      // reading is ordinary traffic, and belongs in the log like everything else.
      async (err) => {
        c.get('logger').info({ component: 'odata', error: err.message }, 'odata page cut short')
      }
    )
  })
)

/**
 * Where each declared column sits in the result's own column order, computed
 * once per page. The two agree in practice — the query is `SELECT *` over the
 * Parquet the schema was taken from — but a column the result does not carry
 * has to come out as null rather than as the column beside it.
 */
function columnPositions(model: EdmModel, columns: string[]): number[] {
  return model.columns.map((col) => columns.indexOf(col.name))
}

/** The shape every row of a page takes: the key, then the table's columns. */
function emptyEntity(model: EdmModel): Record<string, unknown> {
  // A table whose own column is the key carries no extra property — the key
  // arrives with the row like any other value.
  const entity: Record<string, unknown> = model.syntheticKey ? { [model.syntheticKey]: 0 } : {}
  for (const col of model.columns) entity[col.name] = null
  return entity
}

/** Fill that shape with one row's values, in place. */
function fillEntity(
  entity: Record<string, unknown>,
  values: readonly unknown[],
  columns: EdmModel['columns'],
  positions: number[],
  syntheticKey: string | null,
  rowId: number
): void {
  if (syntheticKey) entity[syntheticKey] = rowId
  for (let i = 0; i < columns.length; i++) {
    const at = positions[i]
    entity[columns[i].name] = at < 0 ? null : toEdmValue(values[at], columns[i].type)
  }
}
