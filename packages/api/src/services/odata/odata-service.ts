/**
 * KUKAN OData service (ADR-055, Step 1)
 *
 * Resolves what a resource's OData feed is allowed to show, and reads pages of
 * rows out of its preview Parquet.
 *
 * **Not the ADR-032 sandbox.** That one exists to contain arbitrary user SQL;
 * here the SQL is composed from a page number, so there is nothing to contain.
 * What this path needs is a paged read — and its own concurrency budget, so a
 * BI tool's extract cannot spend the slot the AI query path is queueing for
 * (ADR-055 §2).
 */

import {
  KukanError,
  NotFoundError,
  type Env,
  RequestTimeoutError,
  createCache,
  createLogger,
  type Logger,
} from '@kukan/shared'
import { readRowGroupRows, sqlLiteral } from '@kukan/lake'
import { pageRowsWithin, estimateRowBytes } from './page-budget'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ResourceService } from '../resource-service'
import { PipelineService, isQueryable } from '../pipeline-service'
import { Semaphore } from '../semaphore'
import type { EdmModel, EdmRefusal } from './edm'
import { feedModel, feedRefusal, isEdmRefusal } from './feed-eligibility'
import { capacity } from './capacity'
import { createFeedPool, type FeedLease } from './feed-pool'
import { prepareFeedInstance } from './session'
import {
  ODATA_INSTANCE_IDLE_MS,
  ODATA_INSTANCE_MAX_AGE_MS,
  ODATA_MEMORY_LIMIT_BYTES,
  ODATA_QUEUE_MAX,
  ODATA_QUEUE_WAIT_MS,
  ODATA_READ_TIMEOUT_MS,
} from '../../config'

/**
 * A resource whose feed can be served, or why it cannot.
 *
 * `not-found` covers every way the answer is "there is no such feed here" —
 * no resource, not public, no table — deliberately as one reason: which of
 * them it is, is not a public fact.
 */
export type OdataFeed =
  | {
      ok: true
      model: EdmModel
      previewKey: string
      etagSeed: string
      /** What a row of this table costs a page, for {@link pageRowsWithin}. */
      rowBytes: number | null
      /** Rows in one row group of the preview, or null where the file did not
       *  record it — see {@link pageRowsWithin}. */
      rowGroupRows: number | null
    }
  | { ok: false; reason: 'not-found' | EdmRefusal }

/** One page, held open for reading. `close()` frees the slot and the file. */
export interface PageReader {
  /** Result column names, in the order each row's values arrive in. */
  columns: string[]
  /**
   * Rows this page will deliver at most — the caller's `limit` after the page
   * budget had its say. The caller needs it to tell a full page from the last
   * one, and reading it here rather than re-deriving it keeps one owner for
   * the budget: a clamp this service grows a term for cannot leave the caller
   * deciding there is nothing more to fetch.
   */
  limit: number
  /** Rows in the Parquet's order, a DuckDB chunk at a time. */
  chunks: () => AsyncGenerator<readonly (readonly unknown[])[]>
  close: () => Promise<void>
}

/**
 * The read that would not fit, told as the refusal it is.
 *
 * **A page's read can fail for want of memory, and that is not a server fault.**
 * A Parquet read decodes a whole row group to hand out one row of it, so a table
 * whose group will not fit the slot cannot be read at any page size — DuckDB says
 * so by throwing out of memory, and left alone it reaches the caller as an
 * unexplained 500. Answered here rather than predicted, because the estimate
 * that would have to predict it reads the file's size rather than the file and
 * was measured refusing tables that read — which is why the resource page only
 * cautions (`rowsMayBeTooWide`, in `page-budget.ts`) and never refuses.
 *
 * The read fails before a byte of the page is written (`conn.stream()`), so this
 * arrives as a whole RFC 7807 body rather than a truncated one.
 *
 * Matched on the message because that is what the driver gives; anything it does
 * not match is left alone, which is no worse than before.
 */
function refusalIfTooWide(err: unknown): KukanError | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!/out of memory/i.test(message)) return null
  return new KukanError(
    'This table cannot be served as OData: its rows are too large to read a page of them. ' +
      'Download the file instead',
    'NOT_IMPLEMENTED',
    501
  )
}

function timeoutError(): RequestTimeoutError {
  return new RequestTimeoutError(
    `Reading the feed exceeded the time limit of ${ODATA_READ_TIMEOUT_MS} ms`
  )
}

/**
 * Bounded separately from the ADR-032 query semaphore, per ADR-055 §2.
 *
 * The container's DuckDB peak is the sum of both: a query materializes the
 * whole table inside 256 MB × 1, while a feed reads one page's rows inside
 * {@link ODATA_MEMORY_LIMIT_BYTES} × however many pages the process's memory
 * affords (`capacity`) — bounded by the page, not by the file, which is why it
 * is given the smaller budget.
 */
const odataSemaphore = new Semaphore(capacity.slots, ODATA_QUEUE_MAX, ODATA_QUEUE_WAIT_MS, {
  full: 'The feed is busy; please retry shortly',
})

const feedPool = createFeedPool({
  prepare: prepareFeedInstance,
  idleMs: ODATA_INSTANCE_IDLE_MS,
  maxAgeMs: ODATA_INSTANCE_MAX_AGE_MS,
})

/**
 * Row group sizes this process has read out of a footer, for previews whose own
 * row does not carry one.
 *
 * Keyed on the preview key, which names immutable bytes, so an entry can never
 * be wrong — only forgotten, which costs one more footer read. `0` remembers a
 * file that answered "no groups", so an empty preview is asked once rather than
 * once a page; a read that *threw* is not remembered at all.
 *
 * Kept for a day, which for these entries means kept until the size bound
 * pushes them out (`createCache` always sets some TTL): the bytes an entry is
 * about never change, so an hour's would buy nothing and cost a footer read
 * inside the page's slot on every extract that outlived it.
 *
 * **Nothing here is written back.** Recording the figure for good belongs to the
 * one-time migration an operator runs; a page only needs the number in hand, and
 * the feed is a public read path with no business writing to the catalogue.
 */
const discovered = createCache({ max: 512, ttlMs: 24 * 60 * 60 * 1000 })
/**
 * A settled read's value, or `undefined` where it says the resource is not
 * there — the one rejection this path answers rather than raises, said once
 * for both reads.
 */
function valueOrAbsent<T>(settled: PromiseSettledResult<T>): T | undefined {
  if (settled.status === 'fulfilled') return settled.value
  if (settled.reason instanceof NotFoundError) return undefined
  throw settled.reason
}

export class OdataService {
  private readonly log: Logger

  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    private readonly env: Env,
    logger?: Logger
  ) {
    this.log = logger ?? createLogger({ name: 'api' })
  }

  /**
   * Resolve the feed for `resourceId`, or say why there is none.
   *
   * The visibility check runs **with no viewer** on purpose: v1 serves public
   * resources only (ADR-055 §5), so a private one is absent here even for the
   * person who owns it, rather than being served to a session this path does
   * not read.
   */
  async resolve(resourceId: string): Promise<OdataFeed> {
    // Both reads happen on every page, and both are keyed on the resource
    // alone, so they overlap rather than queue.
    //
    // **Not cached between pages**, which ADR-055 §6 asks for. Measured, the
    // pair is 0.36 ms against a page's ~60 ms, and no cheap key can stand in
    // for what the second read answers: a re-interpretation of unchanged bytes
    // produces a new preview under the same content hash, which is exactly the
    // case this feed's validator exists to catch (see the ETag seed below).
    // A cache keyed on the hash serves the old table for its whole TTL, and the
    // test that pins that hole is the one that says so.
    // **Settled, not raced.** `Promise.all` rejects on the first failure, and a
    // private resource fails the visibility read while the other statement is
    // still running — the handler then answers 404 while a `SELECT` nobody is
    // waiting for is still on the wire. The integration suite is where that
    // shows: the next case's `TRUNCATE` deadlocks against the leftover read.
    // The cost is that a refusal waits for the slower of two 0.36 ms reads.
    const settled = await Promise.allSettled([
      new ResourceService(this.db).getByIdWithOwnership(resourceId),
      new PipelineService(this.db).getQueryTarget(resourceId),
    ])
    const ownership = valueOrAbsent(settled[0])
    const target = ownership && valueOrAbsent(settled[1])
    if (!ownership || target === undefined) return { ok: false, reason: 'not-found' }
    const { resource, pkg } = ownership

    // The same predicate the resource page asks, given the package as it is
    // rather than as this path assumes it. With no viewer, a private or draft
    // resource has already thrown above, so `not-public` cannot come back —
    // but passing the real values means the day this path grows a viewer, the
    // predicate answers instead of agreeing.
    if (!isQueryable(target)) return { ok: false, reason: 'not-found' }
    const refusal = feedRefusal(pkg, target)
    if (refusal) {
      // Only the table's own reasons are a 501; everything else is "no feed
      // here", which is all a stranger gets to learn.
      return { ok: false, reason: isEdmRefusal(refusal.reason) ? refusal.reason : 'not-found' }
    }

    const model = await feedModel(this.db, resourceId, target.schema, target.primaryKey)
    return {
      ok: true,
      model,
      previewKey: target.previewKey,
      // Worked out once per page, from two reads this path already made.
      rowBytes: estimateRowBytes(resource.size, target.encoding, model),
      rowGroupRows: target.rowGroupRows,
      // The Parquet's own key, not the resource's content hash: this feed
      // serves the preview, and the key carries a token that changes every
      // time one is written (`getPreviewKey`). So a re-interpretation of
      // unchanged bytes — a reader fix that moves a column's type, say — is a
      // new identity here, which the content hash alone would have missed.
      // The resource hash rides along for a reader of a log line.
      //
      // The key rides along too: designating one changes `$metadata` and the
      // rows without touching the content, and a validator that missed it
      // would have caches answering with the shape from before.
      etagSeed: `${target.previewKey}:${resource.hash ?? ''}:${model.keyNames.join(',')}`,
    }
  }

  /**
   * Rows in a row group of this preview, from its footer.
   *
   * **The one thing a preview from before the recording cannot be served well
   * without.** Its boundaries cannot be guessed (see {@link pageRowsWithin}), so
   * a page that may straddle has to leave room for two groups — half the row
   * width the same file could otherwise serve. Asking the file settles it.
   *
   * Read in the session the page is already using, so it costs a footer and no
   * connection of its own, and through `@kukan/lake` so the figure the
   * interpretation records and the figure a page reads come from one query.
   * Remembered per process ({@link discovered}), so an extract pays once.
   *
   * **Read, never written.** Filling the row in belongs to the migration an
   * operator runs; this path serves the public and does not write.
   */
  private async rowGroupRowsOf(
    conn: Parameters<typeof readRowGroupRows>[0],
    location: string,
    previewKey: string
  ): Promise<number | null> {
    const seen = discovered.get(previewKey) as number | undefined
    if (seen !== undefined) return seen === 0 ? null : seen
    try {
      const rows = await readRowGroupRows(conn, location)
      // `0` remembers a file that answered "no groups" — an empty table — so it
      // is asked once. A read that *threw* answered nothing: a timed-out or
      // interrupted footer is not evidence about the file, and caching it would
      // hold the page at the pessimistic assumption for the whole TTL.
      discovered.set(previewKey, rows ?? 0)
      return rows
    } catch (err) {
      this.log.warn({ component: 'odata', previewKey, err }, 'could not read row group size')
      return null
    }
  }

  /**
   * Open one page of rows for reading, a chunk at a time.
   *
   * **Nothing here holds the page.** DuckDB streams the result, the rows are
   * converted a chunk at a time, and the caller writes each one out as it
   * arrives — which is what keeps the peak flat in the page size: measured over
   * a 55-column table, 1,818 rows cost 30 MB RSS streamed against 47 buffered,
   * and 20,000 rows cost 23 MB against 337.
   *
   * `skip`/`limit` land straight in the SQL because the synthetic key is the
   * row's position. What makes position 1,000 the same row on the next request
   * as on this one is DuckDB's `preserve_insertion_order`, on by default and
   * checked against a 300,000-row Parquet of 60 row groups, paged whole: the
   * order held at one thread and at four. `threads = 1` is set to bound the CPU
   * a page costs, not to hold the order up.
   *
   * **The object is read where it lies.** The adapter names it and DuckDB
   * fetches the byte ranges the page needs — measured at 0.11–0.18 MB against
   * the 8.9 MB a download of the same Parquet costs, first page and last alike
   * — so nothing is copied through this process and nothing reaches the disk.
   * There is deliberately no path that downloads instead: one would spend the
   * container's disk on every page for a copy no page needs.
   *
   * The setup that can fail — the connection, the query — is done here, before
   * the caller has written a byte, so a failure is still a status code rather
   * than a truncated body. **The caller must call `close()`**: the slot and the
   * connection are held until it does.
   */
  async openPage(
    feed: Extract<OdataFeed, { ok: true }>,
    opts: { skip: number; limit: number | null; signal?: AbortSignal }
  ): Promise<PageReader> {
    const previewKey = feed.previewKey
    await odataSemaphore.acquire(opts.signal)
    const startedAt = Date.now()
    let lease: FeedLease | undefined
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    let drained = false
    let rowsRead = 0

    const close = async () => {
      clearTimeout(timer)
      // Kept only after a page read to its end. A result left unread — the
      // caller walked away, or the page was cut at its byte budget — holds its
      // buffers until the garbage collector gets to it: 5.7 MB measured,
      // counted against the next page's memory limit.
      await lease?.release(drained && !timedOut)
      odataSemaphore.release()
      // One line per request, with no row content: a full extract comes
      // through here once per page (ADR-055 §6).
      this.log.info(
        {
          component: 'odata',
          previewKey,
          skip: opts.skip,
          rows: rowsRead,
          elapsedMs: Date.now() - startedAt,
        },
        'odata page'
      )
    }

    try {
      const location = this.storage.readUrl(previewKey)

      lease = await feedPool.acquire({
        location,
        env: this.env,
        memoryLimitBytes: ODATA_MEMORY_LIMIT_BYTES,
        readTimeoutMs: ODATA_READ_TIMEOUT_MS,
      })
      const conn = lease.conn
      // The timeout covers the whole read, not just its start: a page that
      // stalls half way holds the slot as surely as one that never begins.
      timer = setTimeout(() => {
        timedOut = true
        conn.interrupt()
      }, ODATA_READ_TIMEOUT_MS)

      // Asked of the file where the interpretation did not record it: such a
      // preview is otherwise paged as if every page straddled a group — half the
      // row width it could serve. One footer read per preview per process;
      // writing the figure down for good is the migration's job, not a page's.
      const rowGroupRows =
        feed.rowGroupRows ?? (await this.rowGroupRowsOf(conn, location, previewKey))
      // That read swallows its own failures, the timer has already fired, and
      // `interrupt()` does not fire twice — so a deadline crossed in there would
      // leave everything below it running with none.
      if (timedOut) throw timeoutError()

      // Decided here rather than by the caller: the limit is what DuckDB prepares
      // for and the groups are what it decodes, so both budgets are this
      // service's to keep. `null` is a caller with no `$top` of its own to cap.
      const bound = pageRowsWithin(feed.rowBytes, rowGroupRows, opts.skip)
      const limit = opts.limit === null ? bound : Math.min(opts.limit, bound)

      const result = await conn.stream(
        `SELECT * FROM read_parquet(${sqlLiteral(location)}) LIMIT ${limit} OFFSET ${opts.skip}`
      )
      const columns = result.deduplicatedColumnNames()

      // A chunk at a time, of values in column order. Two things this is not:
      // objects keyed by name — the caller builds one per row anyway, and a
      // throwaway one here cost a third of the mapping — and one row per
      // yield, which pays for the generator 2,048 times over an array that is
      // already in hand.
      async function* chunks(): AsyncGenerator<readonly (readonly unknown[])[]> {
        for (;;) {
          let chunk
          try {
            chunk = await result.fetchChunk()
          } catch (err) {
            // Not turned into a refusal the way the failure at `stream()` is:
            // by here the status and the first rows are gone, so a 501 has
            // nowhere to go. Measured, the read that cannot fit fails at
            // `stream()` — before a byte is written — which is the one this
            // path has to answer.
            throw timedOut ? timeoutError() : err
          }
          if (!chunk || chunk.rowCount === 0) {
            drained = true
            return
          }
          rowsRead += chunk.rowCount
          yield chunk.getRows()
        }
      }

      return { columns, limit, chunks, close }
    } catch (err) {
      await close()
      if (timedOut) throw timeoutError()
      throw refusalIfTooWide(err) ?? err
    }
  }
}
