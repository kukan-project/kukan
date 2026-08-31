/**
 * KUKAN API — Server-side configuration constants
 */

/** Maximum bytes returned by the /text preview endpoint (1 MB) */
export const TEXT_PREVIEW_LIMIT = 1024 * 1024

/** Maximum bytes returned by the /json preview endpoint (10 MB) */
export const JSON_PREVIEW_LIMIT = 10 * 1024 * 1024

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

/** Maximum concurrent queries; excess queues (see below) rather than failing. */
export const QUERY_MAX_CONCURRENT = 1

// Both bounds are on the waiting, not the work: with a concurrency of 1,
// refusing on contention makes a 429 out of two ordinary requests.

/** Callers that may queue for a slot; beyond this, 429 immediately. */
export const QUERY_QUEUE_MAX = 8

/** How long one caller waits for a slot before giving up with 429 (ms). A full
 *  query timeout, so a wait never expires while the caller ahead of it is still
 *  inside its own budget. */
export const QUERY_QUEUE_WAIT_MS = QUERY_TIMEOUT_MS

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

/** Admin-adjustable similarity floor: ±MAX_NOTCHES notches of STEP around the
 *  configured floor (ADR-036). Narrow by design (±0.10 total) — per-model
 *  floors already sit at 97–99% of peak retrieval (ADR-034). */
export const VECTOR_SIMILARITY_STEP = 0.025
export const VECTOR_SIMILARITY_MAX_NOTCHES = 4

/** System-setting read cache TTL — other instances converge within this window */
export const SYSTEM_SETTING_CACHE_TTL_MS = 30_000

/** Bootstrap sysadmin claim older than this with the user table still empty is
 *  a failed first sign-up's leftover and may be re-claimed (ADR-038) */
export const BOOTSTRAP_CLAIM_STALE_MS = 60_000

/** Admin connection test for the AI suggest model. Generous because CPU-only
 *  Ollama can take tens of seconds even for a tiny prompt (ADR-040) */
export const AI_SUGGEST_TEST_TIMEOUT_MS = 60_000

// --- AI metadata suggestions (ADR-040) ---
// How these limits interact (flow, time accounting, gotchas):
// packages/api/src/services/suggest/README.md

/** Head bytes read from the storage original per text resource, and from the
 *  text-head artifact per document resource (discarded after use) */
export const SUGGEST_TEXT_HEAD_BYTES = 16_384

/** ZIP manifest paths listed as material (the archive's true file count is
 *  reported alongside) */
export const SUGGEST_ZIP_MANIFEST_ENTRIES = 50

/** Abort-cap for reading the ZIP manifest into memory. Legitimate manifests
 *  stay small (the worker caps them at 10k entries, ~1-2 MB), but paths are
 *  attacker-controlled — an oversized manifest degrades to metadata-only
 *  material instead of buffering unbounded JSON */
export const SUGGEST_ZIP_MANIFEST_MAX_BYTES = 5 * 1024 * 1024

/** Sample rows read from the preview Parquet per CSV/TSV resource */
export const SUGGEST_SAMPLE_ROWS = 5

/** Per-cell clamp for sample rows — LIMIT bounds rows, not huge text cells */
export const SUGGEST_SAMPLE_CELL_CHARS = 200

/** Columns shown to the LLM per resource. Wide tables (80+ columns) bloat the
 *  prompt and overwhelm small models without improving the description */
export const SUGGEST_MAX_COLUMNS = 20

/** Resources given a name + description slot (content-eligible first; the rest
 *  beyond this cap are name/format context only). A cost / latency / review-UX
 *  cap, not a model constraint — each resource gets its own completion
 *  (ADR-040 parallel-generation addendum) */
export const SUGGEST_MAX_RESOURCES = 20

/** Prompt-material budget per resource completion (one resource's material
 *  plus instructions); content is trimmed largest-first to fit. Sized so a
 *  full 16KB text-head read survives UTF-8 re-encoding growth (Shift_JIS
 *  2-byte chars become 3 bytes) plus JSON escaping */
export const SUGGEST_RESOURCE_PROMPT_BYTES = 32_000

/** Prompt-material budget for the dataset integration completion. Its input
 *  is generated descriptions plus candidates — sized for SUGGEST_MAX_RESOURCES
 *  descriptions at their length clamps */
export const SUGGEST_DATASET_PROMPT_BYTES = 32_000

/** Existing tags (by usage) offered to the LLM as candidates */
export const SUGGEST_TAG_CANDIDATES = 30

/** Existing groups offered as category candidates (closed list — the LLM must
 *  not invent groups). A deliberate cap: sites with more groups than this are
 *  rare; raise it if a deployment needs more. Candidates are usage-ordered so
 *  the cap and the budget ladder drop the least-used first */
export const SUGGEST_GROUP_CANDIDATES = 100

/** Output-token ceilings per completion. Generous relative to the expected
 *  output (a name + a few sentences, or title/notes/tags/groups/name):
 *  hitting the cap truncates the JSON mid-object (ADR-040). Japanese is
 *  token-heavy — a ~300-char description alone can run several hundred
 *  tokens */
export const SUGGEST_RESOURCE_MAX_TOKENS = 800
export const SUGGEST_DATASET_MAX_TOKENS = 2_000

/** Per-completion LLM timeout ceiling — CPU-only Ollama can take minutes even
 *  for a single-resource prompt (ADR-040). The effective per-call timeout is
 *  further bounded by the whole-request deadline below */
export const SUGGEST_TIMEOUT_MS = 120_000

/** Whole-request wall-time budget. Keeps the synchronous endpoint bounded
 *  regardless of resource count: resource completions that would start past
 *  the deadline degrade to name/format context instead. Known limitation:
 *  CloudFront (default readTimeout 30s) / ALB (default idleTimeout 60s) give
 *  up earlier, so a slow cloud generation can time out at the edge while
 *  completing server-side — accepted until async delivery lands */
export const SUGGEST_TOTAL_DEADLINE_MS = 110_000

/** Wall-time reserved for the Phase 2 integration completion */
export const SUGGEST_PHASE2_RESERVE_MS = 30_000

/** Do not launch a resource completion with less budget than this */
export const SUGGEST_MIN_CALL_MS = 5_000

/** Concurrent resource completions per provider (ADR-040 parallel-generation
 *  addendum). Cloud providers parallelize but have RPM/TPM quotas; CPU-bound
 *  Ollama gains nothing from concurrency (matches OLLAMA_NUM_PARALLEL) */
export function suggestConcurrency(provider: string): number {
  return provider === 'ollama' ? 2 : 4
}

/** Backoff before retrying a throttled completion (Bedrock ThrottlingException
 *  / HTTP 429); length = retry attempts */
export const SUGGEST_THROTTLE_BACKOFF_MS = [500, 2_000]

/** Per-user fixed-window rate limit (LLM cost cap). Counted per HTTP request
 *  regardless of how many completions run inside. Sized for the intended
 *  "regenerate a few times and pick the best" workflow across several
 *  datasets an hour */
export const SUGGEST_RATE_LIMIT = 60
export const SUGGEST_RATE_WINDOW_MS = 60 * 60 * 1000
