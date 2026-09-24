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

/**
 * How long the URL a query reads its preview through stays valid (seconds).
 *
 * **Must stay above {@link QUERY_TIMEOUT_MS}**, which bounds the read it has to
 * cover — a longer budget with this unchanged would expire URLs mid-read. Short
 * because it is a bearer capability for that one object: anyone holding it
 * reads the preview without passing the access check.
 *
 * Making it longer buys nothing anyway. It is signed with the task role's
 * temporary credentials, so its real expiry is the earlier of this and what is
 * left of those.
 */
export const QUERY_SOURCE_URL_EXPIRES_S = 60

// NOTE: this path's peak is QUERY_MEMORY_LIMIT_MB × QUERY_MAX_CONCURRENT, ~256 MB, so a
// query gets a full 256 MB for legitimate aggregations and concurrency is serialized to 1
// instead. It is no longer the container's whole DuckDB peak: the OData feed holds a
// budget of its own beside it (ODATA_MEMORY_LIMIT_BYTES × `services/odata/capacity.ts`), and
// unlike this one, that budget follows the memory the process actually has. The two should
// be derived from one figure — see the follow-up issue on the query sandbox.

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

// --- OData feed for BI tools (ADR-055) ---
//
// In the order a page is decided: how big one may be, what its read costs, how
// long it may take, and how many may run at once.

// How big a page may be: the row ceiling, the byte budget that usually ends one
// first, and how much of it is held before going out.

/**
 * Row ceiling for one page, and the cap on `$top`.
 *
 * An outer bound rather than a page's size: the byte budget below, or the row
 * group a page has to stay inside, is what usually ends one, and this is what a
 * narrow table reaches instead. Large because a page costs no more to produce
 * than a small one — the rows are streamed out as they are read rather than held,
 * and only the byte ranges the page needs are fetched (0.11-0.18 MB measured
 * against an 8.9 MB Parquet). What is left to save is round trips, and a
 * million-row table is 20 requests here rather than the 200 a 5,000-row page
 * would take.
 *
 * **What it bounds is the row count, not the bytes.** The byte budget already
 * holds a page to 8 MB whatever the shape, and a page of a numeric table is
 * bigger in JSON than in memory — every row repeats the column names, and
 * `2024-01-02T03:04:05Z` is 22 characters against a timestamp's 8 bytes — so
 * nothing about memory needs this. What does is the array at the other end: past
 * a few tens of thousands of entries, a page is unkind to whatever has to parse
 * it, and `$top` would otherwise have no ceiling at all.
 *
 * A multiple of 2,048, like every other row figure here, so the ceiling itself
 * never cuts a row group in half — 16 of the 4,096-row groups the interpretation
 * writes.
 */
export const ODATA_MAX_PAGE_ROWS = 65_536

/**
 * Largest page written, in bytes of JSON.
 *
 * A wide table repeats every column name on every row — 55 Japanese headings
 * are kilobytes before a single value — so a row count bounds the response
 * poorly. Counted as the rows go out, and the row that would cross it starts
 * the next page instead, which keeps a page's cost flat whatever the table's
 * shape: streamed, a 55-column page measures 30 MB RSS at 1,818 rows and 23 MB
 * at 20,000, against 47 MB and 337 MB read whole.
 */
export const ODATA_MAX_PAGE_BYTES = 8 * 1024 * 1024

/**
 * How much of a page is held before it is written out.
 *
 * A write is an encode and a race against the write deadline; done per row, the
 * races alone measured 15 MB retained and 146 ms on a 50,000-row page, against
 * 13 ms and nothing retained in blocks of this size. It bounds what is held in
 * the process, not what is served — the page is the same either way.
 */
export const ODATA_FLUSH_BYTES = 64 * 1024

// What reading a page costs DuckDB. A page is read a chunk at a time rather
// than the whole table, so this budget is far under what a query needs, and is
// kept separate from the ADR-032 one on purpose (ADR-055 §2). It bounds DuckDB
// only: what bounds Node's heap is that rows go out as they arrive.

/**
 * Per-page DuckDB memory limit, in bytes.
 *
 * 64 MB is enough to stream a page off a million-row Parquet: measured at the
 * same 8 MB page and ~140 ms as the 128 MB it replaced, first page and last
 * alike.
 *
 * In bytes because everything else a page is bounded by is, and passed to DuckDB
 * with a `B` suffix rather than as megabytes. **Its `MB` is 1000-based** — the
 * parser says so itself, refusing a bare number with "expected: KB, MB, GB, TB
 * for 1000^i units or KiB, MiB, GiB, TiB for 1024^i units" — so the `'64MB'`
 * this was written as asked for 61.0 MiB, and that is the figure every
 * measurement here was taken at. Spelled in bytes, nothing turns on which of the
 * two a reader assumes.
 */
export const ODATA_MEMORY_LIMIT_BYTES = 64 * 1000 * 1000

/**
 * Row groups' worth of decoded bytes a page may touch at once — a quarter of the
 * slot above.
 *
 * **A Parquet read decodes a whole row group to hand out one row of it**, so a
 * page costs `groups touched × group bytes` on top of what its own limit
 * reserves, and a page that crosses a boundary holds both groups. What a slot can
 * take is the sum of that, the limit's 8 MB, and DuckDB's own working memory,
 * over allocations it rounds up to powers of two.
 *
 * **Where the ceiling actually is, measured a page at a time in its own process:**
 *
 * | slot   | group reads that serve | that fail |
 * | ------ | ---------------------- | --------- |
 * | 64 MB  | 28 MB                  | 38 MB     |
 * | 128 MB | 38 MB                  | 70 MB     |
 * | 256 MB | 140 MB                 | 210 MB    |
 *
 * So it **tracks the slot at roughly half of it** rather than the slot less a
 * fixed overhead — which would have let 210 MB through at 256 — and that is why
 * this is written as a share rather than a figure: raise
 * {@link ODATA_MEMORY_LIMIT_BYTES} and the ceiling follows.
 *
 * **A quarter, not the half that reads, because the group bytes are counted from
 * an estimated row size** (`estimateRowBytes`) and this is the one decision that
 * estimate is punished for: allow one group too many and the page reads the whole
 * factor more than this says. At a quarter, the estimate has 1.75× of room before
 * reaching the largest read known to serve and 2.4× before the smallest known to
 * fail. The page's own byte budget needs no such gap — being wrong there costs a
 * page a little over or under 8 MB, which no reader can tell.
 *
 * It decides how far a page may run (`pageRowsWithin`) and, with the file's group
 * size, the widest row the feed can serve at all (`maxRowBytes`).
 */
export const ODATA_ROW_GROUP_BUDGET_BYTES = ODATA_MEMORY_LIMIT_BYTES / 4

/**
 * Where a table stops being comfortably readable and the page says so.
 *
 * **A caution, not a refusal.** Whether a row group fits the slot is a question
 * only the read can answer: the estimate this compares was measured calling a
 * table unservable that reads perfectly well (27 MB of group against a 25.6 MB
 * line, where reads actually fail at 38). Refusing on that would take a working
 * feed away; saying "this one may not read" costs a sentence, and the publisher
 * of a table sitting at the edge is exactly who wants to know.
 *
 * 0.4 of the slot is just under the largest group read measured to serve (28 MB
 * of 64), so the caution starts where the evidence stops.
 */
export const ODATA_ROW_GROUP_CAUTION_BYTES = ODATA_MEMORY_LIMIT_BYTES * 0.4

/**
 * The most rows a row group can hold in a preview that did not record its own
 * figure — **a bound, not a value.**
 *
 * Two writers have made previews. hyparquet-writer, until DuckDB took the
 * interpretation over, wrote the 5,000 rows it was asked for exactly; DuckDB
 * rounds a request up to a multiple of its 2,048-row vector, so the same 5,000
 * became 6,144. Both eras are still served — a preview from before `sourceHash`
 * existed is trusted by `schemaDescribesLiveContent` — so an unrecorded file
 * holds 5,000 or 6,144 and nothing distinguishes them from outside.
 *
 * **So it may not be used for boundary arithmetic.** Where a page is cut to a
 * group's end, cutting at the wrong multiple manufactures the straddled read the
 * cut exists to prevent, and there is no safe direction to err in (the two
 * figures share a divisor of 8). An unrecorded group size is treated as unknown
 * instead, and only the pessimistic figures — the widest row a group could hold
 * — are taken from this bound.
 */
export const ODATA_MAX_UNRECORDED_ROW_GROUP_ROWS = 6144

// How long one page may take, at each end of it.

/** Wall-clock timeout for reading one page (ms). */
export const ODATA_READ_TIMEOUT_MS = 15_000

/**
 * Wall-clock budget for writing one page out (ms).
 *
 * Streaming makes the response's pace the server's problem: a caller that
 * reads the headers and then stops reading leaves every write waiting on
 * back-pressure, and the read timeout cannot help — nothing is being read.
 * Without this, one such caller holds the feed's only slot for good.
 */
export const ODATA_WRITE_TIMEOUT_MS = 15_000

// How many pages at once. Not a constant: the count follows the memory the
// process actually has (`services/odata/capacity.ts`), because that is what the
// number is a statement about. Excess queues, then 429 — a BI extract must not
// be able to spend the AI query path's slot, nor the other way round.

/** Callers that may queue for a feed slot; beyond this, 429 immediately. */
export const ODATA_QUEUE_MAX = 8

/**
 * How long one caller waits for a feed slot before giving up with 429 (ms).
 *
 * Longer than a slot can be held, and that margin is the point: at exactly the
 * write budget the wait expires as the slot frees, and which of the two timers
 * fires first is a coin toss — a caller that was about to be served gets a 429
 * instead. Observed, not reasoned: the queue test failed that way roughly half
 * the time before this margin existed.
 */
export const ODATA_QUEUE_WAIT_MS = ODATA_WRITE_TIMEOUT_MS + 5_000

// --- Hybrid (BM25 + vector) search (ADR-034) ---

/** Top-k window fetched from each side (BM25 / vector) before RRF fusion.
 *  Hybrid ranking only affects the fused list (at most 2×FUSION_WINDOW ids);
 *  pages starting beyond it fall back to plain keyword search. */
export const FUSION_WINDOW = 50

/**
 * RRF constant: score(doc) = Σ 1 / (RRF_K + rank).
 *
 * 60 is the published default and was the value here, but it was chosen for
 * result lists far longer than {@link FUSION_WINDOW}. Over 50 items it puts
 * rank 1 and rank 50 within 1.8× of each other, which leaves the fusion asking
 * little beyond "is it in both lists" — a leg's own ordering barely reaches the
 * result.
 *
 * That flatness is also what makes {@link VECTOR_LEG_WEIGHT} dangerous at 60: a
 * full-weight vector hit anywhere in the window would outrank the best keyword
 * hit, and a hit just above the similarity floor would need only 0.064 of a
 * vote to displace it. At 10 the same weight reaches the top ten vector hits
 * and the near-floor threshold rises to 0.225 — stricter than the 0.129 the
 * unweighted fusion had. **The two constants have to be read together.**
 *
 * Swept at a leg weight of 2 (Cohere v4, 51 queries): overall nDCG 89% at K=10
 * against 87% at K=60. The sweep ran offline against the live catalogue; the
 * shipped pair measures 88% in the code itself.
 */
export const RRF_K = 10

/**
 * How much a vector vote weighs against a keyword vote of the same rank.
 *
 * **Plain RRF asks little beyond "is it in both lists."** With RRF_K at 60 over
 * a FUSION_WINDOW of 50, rank 1 and rank 50 are within 1.8× of each other, so a
 * leg's own ordering barely reaches the result — and where keyword search
 * cannot answer at all, one vote is not enough to lift the vector leg's answer
 * over documents BM25 merely happened to match. On the golden set those are the
 * paraphrase and question-form queries, which score 0% and 26% on the keyword
 * leg alone.
 *
 * Measured with `pnpm eval:search` (Cohere v4, 51 queries, floor 0.25,
 * {@link RRF_K} at 10): overall nDCG 81% → 88%, from synonym 79% → 93% and
 * natural 81% → 95%, with `exact` at 100% throughout — a generated paraphrase
 * does not displace a search by a resource's real name, which is decision 8's
 * shipping condition. `word` does not move (63%): a one-word query rarely
 * clears the floor, and weighing a vote the leg never casts changes nothing.
 *
 * Flat from 1.5 upwards in the offline sweep, and 2 is inside the plateau the
 * same sweep finds for per-resource vectors, so a change of embedding unit
 * would not move it.
 *
 * **Taken from the plateau rather than the peak**: 51 queries cannot separate
 * the top of a sweep from its neighbours, and a value that only wins at its
 * exact setting is a value fitted to this catalogue.
 */
export const VECTOR_LEG_WEIGHT = 2

/**
 * How far above the similarity floor a vector hit has to sit to cast a full
 * vote in the fusion. Below that its vote is scaled by its margin: a hit at the
 * floor casts nothing, one at floor + RAMP casts as much as a BM25 hit at the
 * same rank.
 *
 * RRF alone cannot tell rank 1 of a one-item list from rank 1 of fifty. On a
 * short everyday query —「お年寄り」,「車椅子」— the vector leg clears the floor
 * on one or two documents, none of them relevant, and each of those is also
 * somewhere in BM25's list; the tie-break on a second signal then lifts them
 * over the relevant documents BM25 alone had found. Measured on the golden set
 * (Cohere v4, floor 0.30): `word` nDCG 67% → 72%, every other type unchanged,
 * `exact` still 100%. Flat between 0.15 and 0.30 of ramp; 0.20 is the middle.
 * Weighing the whole leg by its best hit instead does nothing (67%) — it is the
 * individual near-floor vote that misleads, not the leg. Measured on Cohere
 * only; a Titan deployment sits on a different floor and should re-measure.
 */
export const VECTOR_VOTE_RAMP = 0.2

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
