/**
 * KUKAN Worker — Configuration constants
 */

/** Maximum file size for external URL fetches (100 MB) */
export const MAX_FETCH_SIZE = 100 * 1024 * 1024

/**
 * How large a redirect's own body may claim to be.
 *
 * {@link MAX_FETCH_SIZE} guards the response the caller keeps; a hop's body is
 * thrown away, so nothing was checking it and each one arrived in full until
 * the cancel landed. A 3xx carries a courtesy page at most — "Moved", with a
 * link — so anything approaching this is not a redirect being served, and
 * generous is the point: the bound has to be obviously above every honest use
 * before it is worth refusing on.
 */
export const MAX_REDIRECT_BODY = 256 * 1024

/** Timeout for fetching external URLs (30 s) */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * How long name resolution may take before the fetch it belongs to gives up.
 *
 * c-ares doubles the timeout per try, so these two are a budget of roughly
 * `DNS_TIMEOUT_MS * (2^DNS_TRIES - 1)` — about six seconds. Kept here beside the
 * timeouts it has to stay under rather than beside the resolver that applies it:
 * six seconds only makes sense against {@link FETCH_TIMEOUT_MS} and
 * {@link HEALTH_CHECK_TIMEOUT_MS}, and a budget that outlives them turns a slow
 * name into a fetch that reports nothing rather than a failure.
 *
 * Left to itself c-ares is far more patient than the `getaddrinfo` it replaced:
 * measured against a real resolver, `.` took 25.8 s to give up where
 * `dns.lookup` took 10.0 s — and `http://./x` parses, so a resource URL can ask
 * for exactly that.
 */
export const DNS_TIMEOUT_MS = 2_000
export const DNS_TRIES = 2

/**
 * How long a name's addresses are reused before asking again.
 *
 * The link health check is the reason there is one. It reads a batch of
 * {@link HEALTH_CHECK_BATCH_SIZE} resource URLs that resolve to far fewer
 * hosts — measured at 458 URLs across 34 — so without this it asks the same
 * question about ten times per host, every five minutes, and the answers are
 * someone else's servers to give.
 *
 * No longer longer than a batch: once {@link HEALTH_CHECK_PER_HOST_INTERVAL_MS}
 * paces the requests, a crowded host takes minutes rather than the six seconds
 * this was sized against, so its name is asked again a few times on the way
 * through. Still a few rather than once per URL, which is what this is for, and
 * still short enough that a host which moves between runs is followed.
 *
 * Zero would not mean "do not cache": `lru-cache` reads it as no expiry at all,
 * which is a name pinned for the life of the process.
 */
export const DNS_CACHE_TTL_MS = 60_000

/**
 * How many names are held at once.
 *
 * Above the 34 distinct hosts a batch was measured to reach, with room for the
 * pipeline's own fetches alongside it — below that the entries evict each other
 * and the caching stops happening.
 */
export const RESOLUTION_CACHE_MAX = 256

/**
 * How many addresses are kept for one name.
 *
 * `net.connect` races the first few and never looks at the rest, so this costs
 * nothing real — and without it a hostile nameserver's answer is held for the
 * whole TTL: five thousand A records measured at 5 MB, times however many names
 * the attacker registers.
 */
export const MAX_ADDRESSES_PER_NAME = 16

/**
 * Rows per Parquet row group. Far below DuckDB's default: the preview reads the
 * file over HTTP range requests, so a small group is what keeps the first screen
 * of rows to a short read.
 */
export const PARQUET_ROW_GROUP_SIZE = 5_000

/** Maximum number of columns allowed in CSV/TSV preview */
export const MAX_CSV_COLUMNS = 500

/**
 * Rows examined at the end of a CSV when looking for footer rows (合計, 注 …).
 * A footer has to run to the bottom of the file to be one, so only the tail can
 * qualify — and reading the whole table back to check would cost more than the
 * interpretation itself.
 */
export const CSV_FOOTER_SCAN_ROWS = 100

/** First-cell prefixes that mark a trailing row as a footer rather than data. */
export const CSV_FOOTER_PREFIXES = [
  '合計',
  '注',
  '※',
  '出典',
  '備考',
  '計',
  'total',
  'note',
  'source',
]

/**
 * Bounds on the DuckDB instance that interprets a CSV (ADR-046). Well under the
 * task's memory so the rest of the run keeps its headroom: DuckDB spills to disk
 * rather than failing when a file needs more, and the read itself streams.
 */
export const INTERPRET_MEMORY_LIMIT_MB = 512
export const INTERPRET_THREADS = 2

/**
 * How many columns one per-column statistics query covers (ADR-046).
 *
 * The bound above is on data, and the statistics pass does not spend it on
 * data: `count(DISTINCT ...)` costs DuckDB a hash table per aggregate, ~2.6MB
 * taken up front whatever the row count. Asking for every column at once
 * therefore fails on width alone — a 14KB, 21-row, 253-column CSV exhausted the
 * limit after 189 of them, and no amount of memory headroom fixes the shape,
 * only moves where it breaks. Batching pays the aggregate cost per batch.
 *
 * 32 keeps a batch under 100MB with room to spare. The extra round trips are
 * not the cost they look like: the table is already materialized, and the whole
 * 253-column pass measured 99ms this way.
 */
export const STATS_COLUMNS_PER_QUERY = 32

/** Leading rows scanned for the title lines Japanese spreadsheets put above the header */
export const CSV_TITLE_SCAN_BYTES = 64 * 1024

/** Bytes collected once encoding detection finds its first non-ASCII byte (64 KB) */
export const ENCODING_SAMPLE_SIZE = 64 * 1024

/**
 * Ceiling on how far encoding detection reads looking for a non-ASCII byte (8 MB).
 *
 * A file with none by here is ASCII as far as anything cares — every candidate
 * encoding decodes it the same way. The bound is what keeps this from
 * transferring a 100MB text whole to answer a question it already has.
 */
export const ENCODING_SCAN_LIMIT = 8 * 1024 * 1024

/** Minimum interval between fetches to the same FQDN (5 s) */
export const FETCH_RATE_LIMIT_INTERVAL_S = 5

/** Delay before retrying a rate-limited fetch (6 s) */
export const FETCH_RATE_LIMIT_REQUEUE_DELAY_S = 6

// ── Content Indexing ──

/** Maximum text size per chunk for content indexing (500 KB) */
export const MAX_CONTENT_CHUNK_SIZE = 500 * 1024

/**
 * Bytes of extracted document text persisted to storage as AI-suggest material
 * (ADR-040 addendum). Larger than the suggest-side read budget so a future
 * budget increase doesn't require reprocessing stored resources.
 */
export const TEXT_HEAD_ARTIFACT_SIZE = 64 * 1024

// ── Semantic Search Embedding (ADR-034) ──

/** Maximum characters of the embedding source text — conservative bound for the
 *  8K-token input limit of the provisional models (Titan v2 / bge-m3) */
export const MAX_EMBED_TEXT_LENGTH = 8_000

// ── Health Check ──

/** Number of resources to check per cron tick */
export const HEALTH_CHECK_BATCH_SIZE = 200

/** Maximum concurrent HEAD requests */
export const HEALTH_CHECK_CONCURRENCY = 10

/** Timeout for HEAD requests (10 s) */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000

/**
 * How many of a batch's checks may be in flight against one host.
 *
 * {@link HEALTH_CHECK_CONCURRENCY} alone counts requests and not who they go
 * to, and a catalog's URLs are not spread evenly across hosts. Measured on a
 * live site: 477 of 481 external URLs were one host, and 305 of them were
 * recorded as dead links answering HTTP 403 — every one of which returned 200
 * when asked on its own, seconds apart. The batch was sending 200 requests to
 * that host in 3.4 seconds. On a second catalog, 452 URLs over 32 hosts, the
 * median host had 4 and the largest had 222; read in staleness order the first
 * 200 rows were 35% one host and 66% three.
 *
 * It also bounds what one unresponsive host can take from the batch. A host
 * that accepts connections and answers nothing holds a slot for
 * {@link HEALTH_CHECK_TIMEOUT_MS}; without this it can hold every slot, and the
 * URL is one any user can register.
 */
export const HEALTH_CHECK_PER_HOST_CONCURRENCY = 2

/**
 * The shortest gap between two of a batch's requests to one host.
 *
 * The concurrency cap above is not a rate: at the 170ms per request a batch was
 * measured at, two in flight is still around twelve requests a second to one
 * server. This is what makes it one.
 *
 * Two seconds rather than one, because one was measured against the same host
 * and still refused. Paced at a second, 121 of that batch's first 165 URLs were
 * served and the rest were not; the 305 that followed over the next ten minutes
 * were refused outright and written down as dead links, as they had been every
 * day before the pacing existed. The host states what it expects in
 * `robots.txt`: its server is configured at 1r/s, and the crawlers it names by
 * hand are asked for a two-second delay — the slower of the two, and the one a
 * checker that names itself nowhere has no claim to be measured against.
 * Sitting exactly on a limit also leaves nothing for the jitter either side.
 *
 * Affordable because the work is nothing like the budget: a day's staleness
 * window against a five-minute tick is 288 chances to check a few hundred URLs.
 * What it costs is that a batch whose rows are one host no longer fits inside
 * {@link HEALTH_CHECK_BATCH_BUDGET_MS} — two hundred rows want four hundred
 * seconds — so its tail is deferred rather than checked. Deferred rows keep the
 * `healthCheckedAt` they arrived with and the batch is read in that order, so
 * they are the front of the next tick rather than a set that starves.
 *
 * Not the pipeline's {@link FETCH_RATE_LIMIT_INTERVAL_S}, which is a row in the
 * database and holds across every process where this holds only within the
 * batch that made it. Sharing that row would put health checks and real fetches
 * in one 5s-per-host queue, where a large catalog's checks would crowd out the
 * fetches a user is waiting on.
 *
 * Which is the bound this does not have: the worker runs as more than one task
 * and each has a scheduler of its own, so the rate a host sees is this one
 * multiplied by however many are up. Ticks are not divided between them either
 * — that is a batch a task claims, and there is no claim yet.
 */
export const HEALTH_CHECK_PER_HOST_INTERVAL_MS = 2_000

/**
 * How long a batch may go on starting checks.
 *
 * The bounds above are per host, and a host that answers nothing turns its own
 * share into `ceil(n / concurrency) * timeout` — a thousand seconds for the
 * largest host measured.
 *
 * Inside the default five-minute tick, so a batch that spends the whole of it
 * still ends before the next would begin. `HEALTH_CHECK_CRON` can be set
 * tighter, and nothing checks the two against each other: overlap is refused
 * rather than queued (croner's `protect`), so a tick shorter than this budget
 * silently costs every tick it overlaps — which is why the
 * budget bounds the *turn* a row waits for rather than the wait itself. Tested
 * after the wait, every row the budget rejects would still cost an interval to
 * reject, and the batch would run past the tick precisely when it is behind.
 */
export const HEALTH_CHECK_BATCH_BUDGET_MS = 240_000

/**
 * How long a job waits before trying a resource someone else is holding.
 * Long enough that a run is not spun on, short enough that a replacement that
 * arrived mid-run is not left waiting out the whole staleness window.
 */
export const CLAIM_RETRY_DELAY_S = 30

/** How often orphaned objects are swept (ADR-043); matches the retention. */
export const ORPHAN_CLEANUP_CRON = '17 * * * *'

/**
 * How often versions that never reached DuckLake are swept back in (ADR-043
 * layer 2). Offset from the orphan sweep so the two do not contend for the
 * catalog, and hourly because it only catches what the queue dropped — the
 * normal path enqueues a retry immediately.
 */
export const LAKE_INGEST_SWEEP_CRON = '37 * * * *'

/**
 * How long an upload URL's object is kept before the sweep reclaims it. Bounds
 * a slow client rather than an in-flight read, so far longer than the orphan
 * retention: reclaiming an upload still in progress would break it.
 */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long an untracked DuckLake file is left alone before it counts as an
 * orphan (24 h).
 *
 * Much longer than the layer-1 retention, and deliberately so. That one waits
 * out readers of a key nothing points at; this one has to outlast the gap
 * between DuckLake writing a Parquet and committing it, and a file caught
 * inside that gap is live data. Reclaiming late costs storage; reclaiming
 * early costs the file.
 */
export const LAKE_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Keys deleted per sweep; the rest wait for the next one. A pipeline run parks
 * up to two objects (live content, preview), so this has to stay well above
 * the runs an hour the deployment does or the backlog never drains.
 */
export const ORPHAN_CLEANUP_BATCH_SIZE = 5000

/**
 * Resource bounds for the worker's DuckLake sessions (ADR-043 layer 2).
 * Unset, DuckDB takes ~80% of container memory and one thread per core, so a
 * few concurrent ingests on a small task would be an OOM kill rather than a
 * slow ingest.
 */
export const LAKE_INGEST_MEMORY_LIMIT_MB = 512
export const LAKE_INGEST_THREADS = 2
