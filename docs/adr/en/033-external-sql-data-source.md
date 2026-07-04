# ADR-033: External SQL Data Sources (Snapshot vs. Live-proxy, both presented + connector extension)

> Machine-translated reference. The Japanese version under `docs/adr/jp/` is authoritative.

## Status

**Proposed** — This ADR does not finalize a method. It organizes the query-execution method
(snapshot vs. live) and the connector distribution/monetization model as a **side-by-side comparison**
to assemble the decision material. The directions written here (especially the "recommended" open-core
boundary) are **all provisional** and will be settled later via a separate finalizing ADR or a revision
of this one, after PoC, demand validation, and legal review.

This extends the "catalog discovery → schema → query" agent loop established in ADR-032 ("MCP Data
Query Foundation") beyond files (preview Parquet): **register external SQL databases as KUKAN
resources and make them queryable through the same MCP interface.**

## Context

ADR-032 let KUKAN convert ≤50MB CSV/TSV into Parquet and query it server-side via a sandboxed DuckDB,
so AI agents can aggregate autonomously through MCP `get_resource_schema` / `query_resource`. However,
much real-world data in governments and enterprises **lives in relational databases, not files**.
Re-exporting them as files to register is impractical for both freshness and effort.

We therefore aim to **register external SQL data sources as KUKAN resources** such that:

- Connection info (host, credentials) is **kept private** (never exposed in API/MCP responses)
- Queries are issued through KUKAN with sanitization
- From MCP they are handled with the **same `query_resource` interface** as Parquet resources

Furthermore, per-engine connectors have **room for commercial sale**, so plugin/extension (open-core)
is in scope.

The core of the ADR-032 sandbox is the following two points, which become the **biggest constraint**
when dealing with external SQL:

- `SET enable_external_access = false` (fully forbids file/URL/httpfs/COPY)
- Materialize Parquet into an **in-memory `data` table** before lockdown (afterward touches neither
  files nor anything external)

"Opening a live connection to an external DB and querying it" **inverts** this premise that "once
ingested, nothing leaves." Hence the existing sandbox cannot be reused as-is — the central issue.

## Options considered

### 1. Query execution method (central issue; both presented)

#### Method S: Snapshot (ELT)

Treat an external SQL source as a **new Fetch source**. Periodically (or on manual reprocess) run the
extraction query and **materialize the result in the same format as preview Parquet**.

```
SQL conn + extraction query ──(scheduled/manual)──▶ Parquet ──▶ existing pipeline (Extract/Index)
                                              └─▶ schema persistence, preview, DuckDB query, MCP all work unchanged
```

- **Pros**
  - Almost **zero** new security surface. Query execution, MCP, and `query_resource` work as in ADR-032.
  - Heavy queries run only "once at extraction time, under server control" → eliminates DoS risk to the
    upstream production DB and the burden of per-engine SQL-injection validation (raw SQL never reaches
    the external DB).
  - DuckDB community extensions (`postgres_scanner` / `mysql_scanner` / `sqlite_scanner`) ingest major
    engines by simply "having DuckDB read the external DB and write Parquet."
  - Consistent with the current invariant "1 resource = 1 tabular dataset" (see "Resource granularity").
- **Cons / trade-offs**
  - **Freshness depends on the extraction interval** (not real-time).
  - Full materialization of large tables consumes storage and extraction time (row/size caps and
    incremental extraction are open issues).
  - Requires an extraction scheduler (cron-like trigger; the worker already has croner).

#### Method L: Live proxy (federation)

KUKAN **relays queries to the upstream DB in real time**. The most faithful to the original proposal.

```
MCP/API query ──▶ KUKAN (validate/sanitize) ──live conn──▶ external DB ──▶ format ──▶ user
```

- **Pros**
  - **Always current.** No materialization storage/latency.
  - Even for huge tables, push only "the needed aggregation" down to the DB (pushdown).
- **Cons / trade-offs**
  - **Conflicts with the ADR-032 sandbox premise (external access forbidden)** → must redesign a
    separate safety model.
  - **Dialects differ per engine, so the cost of guaranteeing "SELECT-only" skyrockets** (validation
    logic that was closed over a single DuckDB now needs per-engine handling).
  - **DoS risk to the upstream production DB** — if an AI throws a heavy `SELECT` (full scan, huge JOIN),
    it drags down a production OLTP. A KUKAN-side timeout cannot stop the remote-side load.
  - Connection pool management, reachability (in closed networks the external DB may be visible only from
    a specific subnet), result-size control.

> **Technical note**: Even in live mode, using DuckDB's `ATTACH` (postgres/mysql/sqlite scanner) as the
> execution engine can absorb dialect differences somewhat. However, `ATTACH` requires enabling the
> `enable_external_access` family, which is **a separate path incompatible** with ADR-032's lockdown.
> Co-locating an "external-access-enabled DuckDB" in the same process is itself a risk, so if live is
> adopted, consider it together with **process separation** of the query service (ADR-032 open issue §2).

#### Method comparison summary

| Aspect                          | S: Snapshot                  | L: Live proxy                 |
| ------------------------------- | ---------------------------- | ----------------------------- |
| Freshness                       | Interval-dependent           | Always current                |
| New security surface            | ~zero (reuse existing)       | Large (sandbox redesign)      |
| Load on production DB           | Once at extraction           | Per query; DoS risk           |
| Per-engine injection validation | Unneeded (raw SQL stays in)  | Required; large dialect gap   |
| Storage                         | Consumes Parquet             | None                          |
| Large tables                    | Full materialize is an issue | Pushdown is advantageous      |
| Existing pipeline reuse         | Full reuse                   | Mostly new                    |
| MCP interface                   | `query_resource` as-is       | Same interface (impl differs) |

> **Recommendation (provisional)**: **Lean v1 toward Method S (snapshot)**. Because the MCP interface
> stays identical, adding Method L later as a "for sources needing freshness" option is transparent to
> users. Place Method L in a separate phase once demand is clear, bundled with process separation and
> per-engine validation. (This recommendation is provisional, to be revisited per PoC and demand.)

### 2. Resource granularity

- **A) The connection itself is a resource**: 1 connection = a "box" of many tables/views. Breaks the
  current invariant "1 resource = 1 tabular dataset," invalidating the premises of schema persistence,
  preview, and query. **Leaning reject.**
- **B) One extraction query/view is a resource (recommended, provisional)**: connection info is held as
  a separate entity (below), and the resource references it while holding a "definition query or view
  name" (a "virtual dataset"). This preserves "1 resource = 1 tabular dataset," so ADR-032's
  schema/preview/query ride on it as-is. The same granularity works for both methods: snapshot
  "materializes this query's result into Parquet"; live "wraps and runs this query."

### 3. Connection info (credential) management

A new responsibility KUKAN has not had. Minimum requirements:

- No plaintext storage in the DB. Abstract **Secrets Manager / SSM Parameter Store** (AWS) and
  encrypted storage for on-prem/closed networks (envelope encryption, etc.). Whether to adapter-ize is
  decided together with §5.
- Connection strings/credentials are **never returned in API/MCP responses** (only schema and query
  results).
- Require **read-only, least-privilege users** on the upstream (mandatory especially for live).
- Assume rotation operations.

### 4. Schema visualization (link to ADR-032 Part A)

- Snapshot: obtain `metadata.schema` from the materialized Parquet via the same path as ADR-032. Almost
  no extra implementation.
- Live: reference the upstream `information_schema`, or run the definition query with `LIMIT 0` to get
  columns/types, then map to ADR-032's schema format.

### 5. Connector distribution/monetization (open-core) and ADR-005 / AGPL

> This section follows the "decide the open-core boundary now" direction, but the **distribution form
> and license boundary are a provisional proposal requiring legal review.**

#### 5-1. Relationship to ADR-005 ("only 4 adapters")

A connector registry effectively adds a **5th adapter family**, an intentional deviation from ADR-005's
design philosophy. This ADR states it **partially extends ADR-005** (ADR-005's status unchanged;
cross-referenced as related). The justification: it is a separate abstraction absorbing not
environment differences but **upstream engine differences**, and an extension point to create a
commercial-distribution boundary.

#### 5-2. Engine line (recommended, provisional)

| Tier                 | Engine                                           | Approach                    | License                            |
| -------------------- | ------------------------------------------------ | --------------------------- | ---------------------------------- |
| Free, bundled        | PostgreSQL / MySQL / SQLite                      | Ingest via DuckDB scanner   | AGPL (bundled)                     |
| Commercial connector | Oracle / SQL Server / Snowflake / BigQuery, etc. | Hand-written via engine SDK | Separately distributed, commercial |

The line **"chargeable = engines DuckDB cannot read"** aligns neatly with the technical boundary
(scanner availability) and the commercial boundary — the strength of this proposal.

#### 5-3. Extension point and license boundary

- Define a `DataSourceConnector` interface (abstracting connect, schema fetch, extract/query execution),
  resolving engine name → connector via a registry.
- **AGPL issue**: distributing a commercial closed connector **dynamically linked** into the AGPL core
  is gray-to-dangerous. The boundary must be clarified by one of the following (**pending legal review,
  provisional**):
  - (a) Carve the extension point (interface layer) into a separate package under a **more permissive
    license** (e.g., Apache-2.0), against which commercial connectors are implemented/distributed.
  - (b) Separate connectors as **separate processes/services** connected via a network-boundary plugin
    API (gRPC/HTTP), avoiding the AGPL linking issue by making it communication rather than linking.
- For v1, design/implement **only the extension point (registry + interface)** first and ship the 3 free
  engines. Actual distribution of commercial connectors comes after (a)/(b) is settled.

## Decision

**This ADR does not decide a single method (proposal stage).** Record the following as the "agreed
starting point":

1. Proceed with the design assuming **resource granularity = Method B (1 extraction query/view = 1
   resource)**.
2. Make **Method S (snapshot) the first candidate for v1** for query execution; position L (live) as an
   extension addable in a later phase while keeping the MCP interface identical (both provisional).
3. Make **credential privacy (no response exposure), least privilege, and Secret storage** mandatory.
4. Assuming **open-core for connectors**, design the `DataSourceConnector` extension point and registry.
   Recommend the line "engines readable by the DuckDB scanner = free/bundled; unreadable = commercial
   connector." The license boundary with AGPL (separate-license extension point or process-separated
   plugin API) is **settled after legal review.**
5. State that this **partially extends ADR-005** (admitting connectors as a 5th adapter family).

Remaining issues requiring finalization are listed under "Open issues."

## Consequences

- **DB**: Add a connection-info entity (holding a Secret reference) and resource metadata ("definition
  query/view + connector kind"). Connection info itself is not stored in plaintext in the DB.
- **packages**: Newly add a `DataSourceConnector` extension-point package (may be a separate package due
  to the license boundary) and a registry. Bundle the 3 free engines' connectors in-tree.
- **worker**: Add the snapshot extraction step (periodic trigger via croner).
- **API/MCP**: Confine query-execution branching to the service layer so that `get_resource_schema` /
  `query_resource` work transparently whether the resource kind is "file" or "external SQL."
- **Security**: Credential privacy, least privilege, and Secret management become new focal points. If
  live is adopted, per-engine SQL validation and process separation are additionally required.
- **License/business**: Settling the open-core boundary (AGPL vs. plugins) requires legal judgment
  before code.
- **ADR-005**: Partially extended by this ADR (adds the connector family).

## Open issues

1. **Final S/L decision**: settle via PoC (snapshot-ingest one Postgres source).
2. **Incremental extraction / large tables**: incremental ingestion avoiding full materialize (updated
   column, CDC, etc.).
3. **Extraction scheduling**: interval config, manual trigger, retry-on-failure UX and pipeline
   integration.
4. **Secret storage abstraction**: dual support for AWS (Secrets Manager/SSM) and on-prem/closed
   (encrypted storage).
5. **Settle AGPL × commercial-connector distribution form**: choose between the separate-license
   extension-point proposal (a) and the process-separation plugin proposal (b) (legal review).
6. **Live-method sandbox design**: per-engine SELECT-only validation, connection pooling, remote-side
   load control, query-service process separation (merges with ADR-032 open issue §2).
7. **Cross-source JOIN**: queries spanning multiple connectors/resources (related to ADR-032 open issue §3).
8. **Rate limiting / billing metering**: cost visibility for high-frequency queries in live mode
   (related to ADR-032 open issue §7).

## Related ADRs

- ADR-005: Only 4 adapters (this ADR partially extends it by adding the connector family)
- ADR-032: MCP data query foundation (the "discovery→schema→query" loop and sandbox this ADR builds on)
- ADR-029 / ADR-016 / ADR-014: column type inference, DuckDB explorer, preview Parquet (target format for snapshot ingestion)
- ADR-017: server-proxied download and visibility check (followed for credential privacy and access control)
- ADR-019: logging strategy (query/extraction logs)
- ADR-021: resource content full-text search (complementary on the discovery→query path)
