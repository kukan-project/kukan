/**
 * KUKAN Worker — Configuration constants
 */

/** Maximum file size for external URL fetches (100 MB) */
export const MAX_FETCH_SIZE = 100 * 1024 * 1024

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
 * Comfortably longer than a batch, which is about six seconds at
 * {@link HEALTH_CHECK_CONCURRENCY}, and far shorter than the five minutes
 * before the next one — so a host that moves between runs is still followed.
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
