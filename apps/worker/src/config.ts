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

/** Byte sample size for encoding detection (64 KB) */
export const ENCODING_SAMPLE_SIZE = 64 * 1024

/** Minimum interval between fetches to the same FQDN (1 s) */
export const FETCH_RATE_LIMIT_INTERVAL_MS = 1_000

/** Delay before retrying a rate-limited fetch (2 s) */
export const FETCH_RATE_LIMIT_REQUEUE_DELAY_S = 2

// ── Content Indexing ──

/** Maximum text size to index per resource (100 KB) */
export const MAX_CONTENT_INDEX_SIZE = 100 * 1024

/** Maximum bytes to download from storage for text extraction (2 MB) */
export const MAX_CONTENT_DOWNLOAD_SIZE = 2 * 1024 * 1024

// ── Health Check ──

/** Number of resources to check per cron tick */
export const HEALTH_CHECK_BATCH_SIZE = 200

/** Maximum concurrent HEAD requests */
export const HEALTH_CHECK_CONCURRENCY = 10

/** Timeout for HEAD requests (10 s) */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000
