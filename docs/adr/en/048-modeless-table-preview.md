> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/048-modeless-table-preview.md`](../jp/048-modeless-table-preview.md).

# ADR-048: One Table Preview — Reading Is Range Delivery, Interaction Is Client-Side Compute

## Status

**Accepted** — supersedes ADR-016 (the adoption of DuckDB-WASM itself is kept;
the "analysis mode" toggle is removed). In light of the spike measurements
(2026-08-31, addendum included), decision 4 (file registration) was amended on
approval from the proposal's "default to `registerFileURL`" to "keep full-buffer
at the current generation cap; activate URL registration together with the cap
raise". The single-table UI and the `/preview` Range fix are implemented.

## Context

### 1. "Analysis mode" is an implementation-driven split that matches no user concept

The table preview currently consists of two tables:

- **Default**: lightweight display via hyparquet. Only the footer and the row groups
  of the visible page are fetched via Range Read (the ADR-017 proxy `/preview`
  serves 206)
- **Analysis mode** (Switch toggle, ADR-016): DuckDB-WASM ingests the **entire**
  preview Parquet via `fetch` + `registerFileBuffer` and performs sort / filter /
  search as client-side SQL

The toggle exists to make the heavy WASM load opt-in — an implementation concern.
To the user it reads as "there are two of the same table, and only one of them can
sort". Moreover, ADR-032's `/query` is publicly exposed as the Data API regardless
of the toggle, so the toggle does not gate "whether analysis is possible" either.
Once server-query-backed interaction is added to the table, the toggle becomes
impossible to explain.

### 2. Groundwork — what this decision does NOT move

Facts confirmed during this deliberation that this ADR leaves unchanged:

- **The preview Parquet cannot be dropped.** It is not a preview-delivery file:
  it is the canonical interpretation of the version (ADR-046), the input to the
  ADR-032 sandbox, and the read target of the primary-key pre-check (ADR-043
  ii-b). It stays regardless of WASM
- **`/query` is anonymously open independent of the toggle.** It is guarded only
  by the visibility check, the SQL length cap, and the semaphore (concurrency 1,
  queue 8, 15 s) — and that suffices. WASM is not a rampart that shrinks the
  attack surface; it is a **QoS valve that diverts well-intentioned interactive
  bursts away from the server**
- **`QUERY_MAX_CONCURRENT = 1` holds only under the offload architecture.** The
  serialization comes from the memory budget of the smallest deployment (512 MB
  web container), and it was acceptable only because human interactive traffic
  never reaches `/query` by design. Moving the table UI onto server queries means
  rebuilding that premise
- **DuckLake is not an interactive compute substrate.** ADR-043's lake reads share
  a single slot and are meant for infrequent operations; they are no alternative
  engine for the preview / explorer

### 3. The prospect of raising the Parquet cap, and the lifespan of full-buffer registration

The preview Parquet generation cap (currently 100 MB) may be raised to several
hundred MB in the future. Full-buffer registration degrades linearly in that world
— but that was an **implementation choice** in ADR-016 ("avoid the extra WASM load
of httpfs"), not a constraint of WASM. DuckDB-WASM has a built-in mechanism to
register a file as a URL and access it via Range Read without any extension
(`registerFileURL` + the HTTP protocol), and the receiving side — `/preview` —
already implements 206 + `Content-Range` for hyparquet. Parquet being columnar,
with URL registration the transfer for one sort is in theory bounded by "the
chunks of the touched column + the visible page".

## Options Considered

### A) Remove WASM and put table interaction on the server's `/query`

- Pros: the engine appears to be a single server-side one. Only result rows are
  transferred, which is kind to slow links
- Cons:
  - The server-side engine stays anyway for MCP / Data API, but absorbing
    interactive bursts requires three prerequisites: a materialization cache, a
    concurrency raise, and flow control for well-intentioned users
  - The smallest deployment (512 MB) can barely raise concurrency (256 MB × 2
    already fills the container) — the worst fit for the closed-network /
    small-on-prem deployment targets
  - Every page turn while a filter is applied becomes a query, which cannot work
    on top of the current per-query full materialization

### B) Consolidate on WASM (drop hyparquet)

- Cons:
  - Every visitor who merely opens a resource page pays for the engine + the
    Parquet. That places the largest cost on the highest-frequency,
    lowest-engagement path and collides head-on with raising the cap
  - The server-side engine remains anyway, so this does not even reduce the
    engine count
- Not viable

### C) Drop the toggle; switch implicitly to client-side compute at the moment of interaction — adopted (proposed)

- Untouched browsing stays on hyparquet Range delivery (zero slot consumption)
- On the first touch of sort / filter, DuckDB-WASM boots in the background; from
  then on that table runs on client-side SQL. The engine switch sinks into
  implementation detail
- Switching registration to `registerFileURL` (Range Read) keeps interaction cost
  from regressing to full transfer even after the cap is raised
- Under the current cost structure this creates no new cliff: today's explicit
  toggle already pays the same amount (engine + full file) at the moment it is
  turned ON. The implicit switch changes the framing, not the amount — and URL
  registration lowers the amount

## Decision (Proposed)

**Unify the table preview into one table, split as "reading = Range delivery /
interaction = client-side compute".**

1. **Drop the "analysis mode" toggle.** Remove the `sessionStorage` +
   `useSyncExternalStore` mode management as well
2. **Never route the untouched display path through `/query`.** Initial render,
   schema, and plain page turns stay on hyparquet Range Reads. Any number of
   passive viewers touch neither the DuckDB slot nor materialization — this
   invariant is what makes the smallest deployment work
3. **Boot DuckDB-WASM implicitly on the first interaction.** While booting, the
   table stays interactive in its hyparquet form; clicked intents are queued and
   applied when the engine is ready. Never block the table with a spinner
4. **Keep full-buffer registration at the current generation cap (100 MB).**
   The proposal defaulted to `registerFileURL` (Range Read), but the
   measurement addendum (second leg of the two-phase read) showed that the
   visible rows of a sorted page scatter across the whole file, so row-group
   granular fetching costs ~50 MB per page. A full buffer pays the whole file
   (≤ cap) once on the first interaction and every operation after that is
   free — strictly better within the current cap. **Activating URL
   registration is follow-up work bundled with raising the generation cap,
   retuning `ROW_GROUP_SIZE` (ADR-014 detail amendment), introducing the size
   threshold, and bumping duckdb-wasm** — the server-side receiving end
   (`/preview`'s RFC 9110 compliance) ships with this ADR, so only the
   client's registration call needs swapping at that point
5. **State the server side as an explicit boundary: unchanged.** `/query`, the
   sandbox, and `QUERY_MAX_CONCURRENT` are untouched. Generation and retention of
   the preview Parquet are unchanged. SQL over past versions (privileged export →
   sandbox) is a separate ADR

## Spike (Validation Gating Approval)

Timebox: 2 days. The measurement harness lives in `spike/adr-048/` (synthetic
data, the vendored bundle, and the results JSON are generated artifacts and stay
out of the repository). Measured results below.

### Questions

| #   | Question                                             | Known background                                                                                                                                                    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Does it mesh with `/preview`'s Range implementation? | Two landmines confirmed: suffix form `bytes=-N` is rejected with 416 / open-ended `bytes=N-` is clamped to 1 MB (breaks a client expecting the full requested run)  |
| Q2  | Does the HEAD response advertise Range capability?   | DuckDB-WASM inspects `Accept-Ranges` / `Content-Length` and, if ranges look unsupported, **silently falls back to a full download**                                 |
| Q3  | Actual bytes transferred for one sort                | In theory only the touched column's compressed chunks. With `ROW_GROUP_SIZE 5000` there are many row groups, so the footer metadata cost itself is measured         |
| Q4  | Do repeated operations re-fetch?                     | Buffer-cache behavior is unknown. If paging through a sorted result re-reads the column every time, this is not usable                                              |
| Q5  | Browser heap peak                                    | Sort intermediates. Target ≤ 1.5 GB on desktop                                                                                                                      |
| Q6  | Effect of row-group granularity                      | Compare Q3/Q4 across two variants: 5,000-row and 100,000-row groups. Feeds the decision whether Interpret's `ROW_GROUP_SIZE` (ADR-014) is revisited for large files |

### Procedure

1. **Preparation**: generate a 300–500 MB synthetic Parquet under the same
   conditions as Interpret (zstd, row group 5000), plus a 100,000-row-group
   variant
2. **Phase 1 — isolate compatibility**: measure raw behavior (Q2–Q5) against an
   ideal Range server (suffix support, full requested runs). Detecting the
   full-download fallback has top priority
3. **Phase 2 — the real proxy**: same measurements against
   `/api/v1/resources/:id/preview`. Confirm whether the Q1 landmines are hit and
   enumerate the required server fixes (the fixes are implementation scope)
4. **Measurement scenarios** (per variant): metadata read / `COUNT(*)` / numeric
   column sort + first page / string column sort / equality and ILIKE filters /
   five page turns through a sorted result / re-running the same sort. Record
   request count, total bytes, wall time, and heap peak per scenario

### Verdict Criteria

- **Go**: no full-download fallback; one sort transfers ≤ ~1.5× the touched
  column's compressed size; paging does not re-read columns; operations complete
  in 3–5 s on a typical link (assume 50 Mbps); heap ≤ 1.5 GB → update this ADR to
  accepted and proceed to implementation
- **Conditional go**: transfer volume is fine but re-fetching is frequent → keep
  the direction with a size-threshold gate (small files as full buffers, URL only
  for large ones)
- **No-go**: the full-download fallback cannot be avoided, or paging never reaches
  usable speed → withdraw this ADR and design option A (server queries +
  materialization cache + concurrency raise) in a separate ADR

### Measured Results (2026-08-31)

Environment: loopback (RTT ≈ 0; on a real network add request count × RTT),
headless Chromium, duckdb-wasm 1.33.1-dev57.0, synthetic Parquet of 6,000,000
rows × 7 columns (zstd, rg5000 = 406 MB / rg100k = 396 MB; the sort column
`num_a` compresses to 18.8 MB → criterion 1.5× = 28 MB).

**Preconditions measured (Q2, full-download fallback):** with registration as it
is today (no config), the first query **always downloads the entire file even
against an ideal range server** (1 request, 387 MB). Range mode only activated
with both `db.open()` filesystem flags (`reliableHeadRequests: true` etc.) **and**
`directIO: true` on `registerFileURL`. `allowFullHTTPReads: false` (strict mode)
fails the open outright in this build without issuing a single request — the
behavior depends on dev-release internals, so implementation must include a
duckdb-wasm version bump and regression checks.

**Phase 1 (ideal range server, range mode):**

| Scenario                                             | rg5000 (transfer / requests) | rg100k (transfer / requests) | Verdict                    |
| ---------------------------------------------------- | ---------------------------- | ---------------------------- | -------------------------- |
| Metadata read                                        | 0.91 MB / 4                  | 0.06 MB / 4                  | ✓ dramatically cheap       |
| COUNT(\*)                                            | 0 MB / 2                     | 0 MB / 2                     | ✓                          |
| Equality filter                                      | 0.41 MB / 11                 | 21.3 MB / 13                 | ✓                          |
| ILIKE filter                                         | 0.28 MB / 7                  | 9.9 MB / 13                  | ✓                          |
| `SELECT *` sort (straight Top-N)                     | 162 MB / 571                 | 372 MB / 44                  | ✗ nearly the whole file    |
| `SELECT *` page turns (each)                         | 158–277 MB / 2128–5604       | 374–378 MB / 37–484          | ✗ re-transferred each      |
| **Sort-column-only projection (two-phase, 1st leg)** | **4.5 MB / 238**             | **18.0 MB / 61**             | **✓ within the 28 MB bar** |
| Same, re-run (cache check)                           | 7.4 MB / 385                 | 18.6 MB / 63                 | △ no cross-query cache     |

- **Straight `SELECT *` Top-N sorting does not work** (late materialization does
  not apply; nearly the whole file is transferred, again on every page turn).
  **The "two-phase read" — project only the sort column to fix row positions,
  then fetch the visible rows in a second query — stays within the bar.**
  Min/max zonemap pruning improves with finer row groups (down to 4.5 MB on
  rg5000)
- **There is no cross-query cache** (Q4). Every interaction re-transfers roughly
  the column size (5–19 MB). At an assumed 50 Mbps that is 1–3 s — usable, but
  painful on slow links. On a real network request count × RTT adds on top; the
  hundreds-to-thousands of requests on rg5000 are a breaking factor (238
  requests ≈ 7 s at 30 ms RTT). Row groups need to move to the tens of
  thousands of rows (Q6; rg100k needs only 61 requests but transfers 18 MB —
  the sweet spot is explored at implementation time)
- Memory (Q5): total Chromium RSS was 0.6–1.9 GB in range mode vs 1.2–1.6 GB
  full-buffer — the same ballpark, at the edge of the 1.5 GB bar; the size
  threshold gate remains a prerequisite for mobile

**Addendum: the second leg of the two-phase read (fetching the visible rows).**
The first leg (sort-column projection to fix row positions) stays within the
bar, but measuring the second leg — fetching the visible rows by
`file_row_number IN (...)` — showed **~49 MB per page on rg5000 (scattered
across 93 row groups) and 343 MB on rg100k (nearly the whole file)**.
`file_row_number` pruning itself works (100 consecutive rows cost 0.4 MB), but
the visible rows of a sorted page scatter across the whole file, so the floor
is the number of row groups they land in × the group size. No implementation
strategy avoids this structure: **sorted browsing over range reads bottoms out
at ~50 MB per operation.** Filters (predicate pushdown) and metadata stay cheap
as measured above. This addendum is the basis for amending decision 4 (keep
full-buffer at the current cap).

**Phase 2 (faithful `/preview` emulation, Q1):** range mode **fails completely**
(every query dies with `No magic bytes found at end of file`). The cause is
pinned down: duckdb-wasm probes the size with `HEAD` + `Range: bytes=0-` and
interprets the response's `Content-Length` as the full file length, but the
current implementation clamps open-ended ranges to 1 MB — **the file size is
misread as 1 MB and the footer is read from the wrong offset**. The suffix form
(`bytes=-N`) is never used by duckdb-wasm, so that 416 landmine was not hit
(fixing it remains desirable for spec robustness). Full-buffer mode passes
through unharmed.

### Verdict, and What Was Settled on Approval

The first-pass verdict was **conditional go** ("transfer volume within the bar,
re-fetching remains"); the addendum (~50 MB per sorted page) narrowed range
reads' applicable domain, settling as:

- **Implemented (the scope this ADR approves)**: `/preview`'s RFC 9110
  compliance (full-length answers to open-ended ranges, suffix form,
  huge-numeral guard, answering 200 rather than a mislabeled 206 when the
  backend ignored the Range, and explicit HEAD. Per §14.2 HEAD ignores Range
  and always answers the full size — DuckDB-WASM's size probe reads
  Content-Length without checking the status, and range mode was confirmed to
  activate under this shape against the real engine. The real stack was also
  confirmed to return `Content-Length` on HEAD — the proposal's real-stack
  check is resolved), and
  the single-table UI (toggle removed, implicit engine boot, interactions queue
  naturally as React state, an engine failure demotes to plain reading instead
  of killing the table). Transport stays full-buffer as today
- **Settled as follow-up work (bundled with raising the generation cap)**:
  switching to `registerFileURL`, the size threshold, retuning `ROW_GROUP_SIZE`
  (ADR-014 detail amendment), and the duckdb-wasm bump with regression checks
  (range-mode activation depends on dev-build implementation details — both the
  filesystem flags and `directIO: true` must be set). The economics at that
  point start from this ADR's measurements (first leg 4.5–18 MB, second leg
  ~50 MB per page, filters 0.3–21 MB)

## Consequences

- `apps/web`: the toggle UI and `sessionStorage` mode management are removed.
  `DataExplorer` is the one table: initial rendering via hyparquet (range
  reads, no engine), and the first sort/filter/search boots DuckDB-WASM in the
  background. The old `ParquetPreview` component is deleted (the hyparquet hook
  itself stays in service for initial rendering and the primary-key picker).
  Key marking and numeric alignment are carried by the explorer's table
- `packages/api`: `/preview` fixed to RFC 9110 range semantics (confirmed
  mandatory by measurement; details in the results section). HEAD now answers
  from object metadata alone, which also removes the opened-and-discarded S3
  stream per probe
- `apps/worker`: unchanged. Retuning `ROW_GROUP_SIZE` is follow-up work bundled
  with activating URL registration (the cap raise)
- Raising the preview Parquet generation cap is decided separately, using this
  ADR's measurements as input

## Open Questions

1. SQL over past versions (privileged export → sandbox) is decided in a separate
   ADR. If the exported version Parquet is served through a `/preview`-equivalent
   endpoint, this ADR's single table can explore past versions too (the merge
   point)
2. Engine pre-warming before the first interaction (e.g. triggered by
   pointerenter on the table header) is considered at implementation time.
   Prefetching on page load is ruled out — it charges every viewer

## Related ADRs

- ADR-016: DuckDB-WASM Data Explorer (**this ADR proposes to supersede it**; the
  engine adoption stays, the toggle and full-buffer registration are overturned)
- ADR-014: Parquet preview format (possible `ROW_GROUP_SIZE` revisit)
- ADR-015: Unified preview-url endpoint (superseded; the story of presigned
  direct reads failing on HEAD/CORS is the same root as Q2)
- ADR-017: Server-proxied download / preview URL (the Range-capable proxy is this
  ADR's foundation; remains in force)
- ADR-032: MCP data query foundation (`/query` and the sandbox are out of scope
  here)
- ADR-043: Resource versioning (premise that DuckLake is not an interactive
  compute substrate)
- ADR-046: Separating the canonical file from its interpretation (why the preview
  Parquet remains the canonical interpretation)
