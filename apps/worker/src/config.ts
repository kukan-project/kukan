/**
 * KUKAN Worker — Configuration constants
 */

/** Maximum file size for external URL fetches (100 MB) */
export const MAX_FETCH_SIZE = 100 * 1024 * 1024

/** Timeout for fetching external URLs (30 s) */
export const FETCH_TIMEOUT_MS = 30_000

/** Maximum file size for CSV/TSV Parquet preview generation (50 MB) */
export const MAX_PARQUET_SOURCE_SIZE = 50 * 1024 * 1024

/** Number of rows per Parquet row group */
export const PARQUET_ROW_GROUP_SIZE = 5_000

/** Maximum number of columns allowed in CSV/TSV preview */
export const MAX_CSV_COLUMNS = 500

/**
 * Literals recognized as booleans during CSV/TSV column type inference (ADR-029),
 * matched case-insensitively. Kept strict to avoid colliding with integers (0/1)
 * or locale variants (yes/no, はい/いいえ); extend here if that changes.
 */
export const BOOLEAN_LITERALS = new Set(['true', 'false'])

/** Byte sample size for encoding detection (64 KB) */
export const ENCODING_SAMPLE_SIZE = 64 * 1024

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

/** How often orphaned objects are swept (ADR-043); matches the retention. */
export const ORPHAN_CLEANUP_CRON = '17 * * * *'

/** How long an object nothing points at is kept, so in-flight reads finish. */
export const ORPHAN_RETENTION_MS = 60 * 60 * 1000

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
