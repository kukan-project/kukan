# ADR-032: MCP Data Query Foundation (Schema Persistence + Server-side DuckDB Query)

> Machine-translated reference. The Japanese version under `docs/adr/jp/` is authoritative.

## Status

**Accepted** — Both Part A (schema persistence) and Part B (server-side DuckDB query) are implemented.

Persists the column schema derived by ADR-029 ("CSV/TSV preview Parquet column type inference")
and extends the query capability of ADR-016 ("DuckDB-WASM data explorer") to the server side so it
can be consumed over MCP (Model Context Protocol).

## Context

KUKAN already ships an MCP server (`packages/api/src/mcp/`, HTTP Streamable / stateless) exposing
**catalog discovery** tools: `search_datasets` → `get_dataset` → `get_resource`. But every tool stops
at metadata and cannot operate on the data itself. To an AI agent this is "a library whose table of
contents is readable but whose contents are not."

Two concrete gaps:

1. **Fields (columns) are invisible.** A resource's column names and types are only known after the
   user downloads the Parquet. Yet the Extract step already runs type inference (ADR-029
   `inferColumnType()`) and fixes column names/types at that moment — **the result is discarded, not
   persisted.**
2. **No server-side querying.** SQL queries today run only in the browser via DuckDB-WASM
   (`apps/web/src/hooks/use-duckdb.ts` / `duckdb-sql.ts`). There is no way to aggregate or filter the
   data from the API or MCP.

Closing both yields a closed agentic loop:

```
search_datasets → get_dataset → get_resource_schema → query_resource
```

turning KUKAN into a data foundation an AI can explore and aggregate autonomously. This is the
equivalent of CKAN's DataStore + `datastore_search_sql`, realized by **querying the existing Parquet
preview directly** rather than loading data into dedicated tables.

## Options Considered

### Schema visibility

- **A) Extract from the Parquet footer on demand** — range-read the footer from storage each time.
  No persisted data, but repeated I/O and nothing to feed the search index.
- **B) Persist at pipeline time (chosen)** — write the already-determined column names/inferred types
  into `resource_pipeline.metadata`. Near-zero extra cost, benefits MCP, UI, and future column-name search.

### Server-side query engine

- **A) Server-side DuckDB (chosen)** — query Parquet natively, sharing logic with the front-end
  DuckDB-WASM and exploiting columnar pushdown.
- **B) PostgreSQL DataStore (CKAN-style)** — a Postgres table per resource. Heavy for variable schemas
  and many resources, and contradicts the "no extra adapters" principle (ADR-005).
- **C) No query support** — leaves the gap. Rejected.

### Query interface

- **A) Raw SQL (SELECT-only, sandboxed) (chosen)** — AI is fluent in SQL; most flexible and powerful.
  Safety comes from sandboxing the execution environment.
- **B) Structured query (filters/sort/aggregate)** — share `duckdb-sql.ts` and compile to SQL on the
  server. Smaller attack surface but limited expressiveness.

### Query process placement

- **A) Inside the API (web) process (chosen)** — simplest; reuses storage adapter, auth, and visibility
  checks. Trades a native addon dependency and memory load onto web, acceptable given the ≤50MB preview
  cap (ADR-029) and bounded concurrency.
- **B) Dedicated query service / Worker** — isolates heavy queries but adds components and a deploy path.
  Split out later when scale demands it (open issue).

## Decision

**Two coordinated changes.**

### Part A — Persist the column schema

1. In the Interpret step (`apps/worker/src/pipeline/steps/interpret.ts`), while generating the Parquet,
   assemble each column's `{ name, type, nullable, nullCount, stats? }` plus `rowCount` and store it
   in `resource_pipeline.metadata.schema`. `type` reuses the ADR-029 inferred types
   (`integer` / `float` / `boolean` / `string`). `stats` holds min/max for numeric columns
   (`integer` / `float`, only when there is at least one non-null value), computed in the same pass as
   cell conversion (no extra scan). Integer bounds are decimal strings (INT64 can exceed JS Number's safe range); float
   bounds are numbers. Distinct/sum/avg are out of scope for Parquet statistics and are left to Part B
   queries.
2. Applies only to **formats that produce a Parquet** (CSV/TSV, ≤50MB). Everything else (PDF, images,
   oversize CSV) has no `schema` (`null`).
3. Exposure:
   - API: `GET /api/v1/resources/{id}/schema` — returns the stored schema after a visibility check.
     A missing schema (unsupported format / not processed) returns an explicit response with
     `queryable: false` rather than a 404.
   - MCP: `get_resource_schema` tool — returns columns, types, row count, and a note that the queryable
     table is named `data`.
4. **Backwards compatibility**: existing resources gain a schema as they are reprocessed (`reprocess`).
   No bulk backfill (same stance as ADR-029 §7).

### Part B — Server-side DuckDB query

1. **Library**: add `@duckdb/node-api` (the official native binding) to the API process.
2. **Exposure**:
   - API: `POST /api/v1/resources/{id}/query` (body `{ sql: string }`)
   - MCP: `query_resource(id, sql)` tool (`readOnlyHint: true`)
3. **Loading the Parquet**: fetch the preview Parquet (`preview_key`) via the storage adapter and write
   it to a temp file; always delete it in `finally`. (v1 does not cache the temp file — on the web
   process memory is the scarce resource, so the bytes go to disk, not the heap. A per-`previewKey`
   temp-file cache (a dedicated LRU that unlinks on dispose) is deferred to Open Question §4.)
4. **Sandbox (the core of this ADR)**: build a **disposable DuckDB instance per query** and isolate it
   fully, in order:
   1. With external access still enabled, **materialize the Parquet into an in-memory table `data`**
      (`CREATE TABLE data AS SELECT * FROM read_parquet('<tmp>')`). No file is touched afterward.
   2. Lock the configuration down:
      - `SET enable_external_access = false` (bans files/URLs/httpfs/COPY entirely)
      - `SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`
      - `SET memory_limit = '<cap>'; SET threads = <cap>;`
      - `SET lock_configuration = true;` (user SQL can no longer `SET` anything back)
   3. **Validate the user SQL** (defense in depth):
      - Allow exactly one statement (no `;` except trailing).
      - Allow only a leading `SELECT` or `WITH`. Reject `PRAGMA` / `ATTACH` / `COPY` / `INSTALL` /
        `LOAD` / `SET` / `CALL` / `EXPORT` / `INSERT` / `UPDATE` / `DELETE` / `CREATE` / `DROP`, etc.
      - Even with a leading `WITH`, reject statement-level write/DDL keywords to block a CTE that wraps
        a write (`WITH x AS (...) DELETE ...`); judged on scrubbed text with comments/strings blanked
        (`replace` is excluded as a SELECT function).
      - Note: thanks to step 2, even a validation bypass cannot perform file access, DDL/DML, or
        extension loading. Validation is one layer, not the sole defense.
   4. **Row and time caps**:
      - Read the result stream and **truncate at a max row count** (a cap independent of query shape),
        plus a max result-byte cap.
      - Apply a **wall-clock timeout** that `interrupt()`s the connection (DuckDB has no SQL-level
        statement_timeout, so cancel explicitly on timeout). The timer also covers materialization, so a
        huge/pathological Parquet cannot hold the connection and semaphore. Timeouts return `408`
        (`RequestTimeoutError`).
   5. Dispose of the instance when the query finishes.
5. **Concurrency and memory**: a semaphore bounds concurrent queries. A query's `memory_limit` and the
   concurrency bound DuckDB's memory peak (≈ `memory_limit × concurrency`). Excess requests return `429`
   (`TooManyRequestsError`); they are not queued. **v1 defaults conservatively to `memory_limit = 256MB`
   × concurrency 1** (~256MB peak) to avoid OOM on the web container (small = 512MB). Scaling with the
   deployment size is an open question.
6. **Access control**: run through the same `getByIdWithAccessCheck` as preview (ADR-017). SQL validation
   (length + read-only) runs **before** the download/materialize, which also enforces the length limit on
   the MCP path.
7. **Explicit query target**: the AI queries the fixed table name `data`. The table name, columns, and
   types are stated in the `get_resource_schema` output and the `query_resource` description so the
   agent writes SQL after seeing the schema.
8. **Result format**: the API returns JSON (`{ columns, rows, rowCount, truncated, elapsedMs }`, where
   `rows` is an array of column-keyed objects); the MCP `query_resource` tool returns a Markdown table.
   Values are serialized JSON-safe (BIGINT, etc. become strings).

## Consequences

- **DB**: no schema change (only an extension of `resource_pipeline.metadata` JSONB). Define the
  `metadata.schema` shape as a Zod schema in `packages/shared`.
- **Worker**: `extract.ts` assembles and returns the schema; `process-resource.ts` saves it to
  `resource_pipeline.metadata`. Inference already runs, so compute cost is near-zero.
- **API**: add the `@duckdb/node-api` dependency and a query service (sandbox, semaphore, timeout). Add
  `RequestTimeoutError`(408) / `TooManyRequestsError`(429) to `@kukan/shared`. Add the `/schema` and
  `/query` routes and the two MCP tools.
- **Deploy**: `@duckdb/node-api` is a native addon (in-process, not a sidecar). Adding it to
  `next.config` `serverExternalPackages` makes the Next.js standalone trace bundle the `.node` binary,
  and **the alpine musl binding is resolved, so no Docker base-image change is needed** (verified on
  `node:24-alpine`). Set memory caps both in the query sandbox (`memory_limit`) and the ECS task
  definition.
- **Security**: this opens a raw-SQL surface to an external (AI) caller; the sandbox settings (notably
  `enable_external_access=false` + `lock_configuration=true`) are mandatory and a review focus.
- **Observability**: log the query SQL, execution time, and truncation (rows/time) (ADR-019).
- **Tests**: unit tests for the SQL validator (multiple statements, non-SELECT, comment spoofing, case);
  integration tests for the sandbox (`read_parquet`/`COPY`/`ATTACH`/`INSTALL` reliably fail; row/time
  caps hold); pipeline integration test for schema persistence.

## Open Issues

1. **Expand queryable targets**: today only ≤50MB CSV/TSV. Extend to large files or JSON (raise the cap,
   or query the raw file directly via DuckDB httpfs).
2. **Split out a query service**: separate from the web process under load (option B).
3. **Cross-resource JOINs**: join multiple Parquets in one query (register multiple tables).
4. **Cache temp files / instances**: v1 downloads then deletes per query. A per-`previewKey` temp-file
   cache (an LRU that unlinks on dispose), and further caching the locked DuckDB connection per resource,
   would cut consecutive-query latency (deferred due to concurrency complexity).
5. ~~**Result format**~~ (resolved): API = JSON, MCP = Markdown table (Part B-8). Additional formats such
   as CSV can be considered on demand.
6. **Scale-linked limits**: inject `memory_limit` × concurrency from the deployment scale
   (small/medium/large) so medium and up run more concurrent queries (v1 uses conservative constants).
7. **Rate limiting / billing**: rate-limit and surface the cost of frequent, expensive AI queries.

## Related ADRs

- ADR-004: lru-cache (used to cache the temp Parquet)
- ADR-005: only four adapters (DuckDB is not adapterized — the basis for this ADR's stance)
- ADR-014 / ADR-016 / ADR-029: preview Parquet / DuckDB explorer / column type inference (the
  foundation this ADR builds on)
- ADR-017: server-proxied download / preview URL (visibility-check approach reused)
- ADR-019: logging strategy (query logs)
- ADR-021: resource content full-text search (complements the explore→query flow)
