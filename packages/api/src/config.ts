/**
 * KUKAN API — Server-side configuration constants
 */

/** Maximum bytes returned by the /text preview endpoint (1 MB) */
export const TEXT_PREVIEW_LIMIT = 1024 * 1024

/** Maximum bytes returned by the /json preview endpoint (10 MB) */
export const JSON_PREVIEW_LIMIT = 10 * 1024 * 1024

/** Default Range chunk size for preview endpoint (1 MB) */
export const DEFAULT_RANGE_CHUNK = 1024 * 1024

// --- Server-side DuckDB query sandbox (ADR-032 Part B) ---

/** Maximum rows returned by a single query (excess is truncated). */
export const QUERY_MAX_ROWS = 10_000

/** Maximum serialized result size before rows are dropped (5 MB). */
export const QUERY_MAX_BYTES = 5 * 1024 * 1024

/** Wall-clock timeout per query; the DuckDB connection is interrupted on expiry (ms). */
export const QUERY_TIMEOUT_MS = 15_000

// NOTE: total DuckDB memory peak ≈ QUERY_MEMORY_LIMIT_MB × QUERY_MAX_CONCURRENT. These
// conservative defaults cap the peak at ~256 MB so the web container does not OOM even on
// the small scale (512 MB). Each query still gets a full 256 MB so legitimate aggregations
// succeed; concurrency is serialized to 1 instead. TODO: scale these with the deployment
// size (env-injected from CDK) so medium/large can run more concurrent queries.

/** Per-query DuckDB memory limit (bounds materialization + working memory). */
export const QUERY_MEMORY_LIMIT_MB = 256

/** Per-query DuckDB thread count. */
export const QUERY_THREADS = 2

/** Maximum concurrent queries; excess is rejected with 429. */
export const QUERY_MAX_CONCURRENT = 1

/** Maximum length of a user-supplied SQL string. */
export const QUERY_MAX_SQL_LENGTH = 10_000

// --- Hybrid (BM25 + vector) search (ADR-034) ---

/** Top-k window fetched from each side (BM25 / vector) before RRF fusion.
 *  Hybrid ranking only affects the fused list (at most 2×FUSION_WINDOW ids);
 *  pages starting beyond it fall back to plain keyword search. */
export const FUSION_WINDOW = 50

/** RRF constant: score(doc) = Σ 1 / (RRF_K + rank). 60 is the standard value. */
export const RRF_K = 60

/** Query-embedding timeout — kept short so an embedding-provider outage
 *  degrades every search to keyword-only instead of stalling it. */
export const QUERY_EMBED_TIMEOUT_MS = 2_000

/** Query-embedding LRU cache size / TTL */
export const QUERY_EMBED_CACHE_MAX = 1_000
export const QUERY_EMBED_CACHE_TTL_MS = 60 * 60 * 1000
