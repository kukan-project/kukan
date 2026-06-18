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

// ── Health Check ──

/** Number of resources to check per cron tick */
export const HEALTH_CHECK_BATCH_SIZE = 200

/** Maximum concurrent HEAD requests */
export const HEALTH_CHECK_CONCURRENCY = 10

/** Timeout for HEAD requests (10 s) */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000
