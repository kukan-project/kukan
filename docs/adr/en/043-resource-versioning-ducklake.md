# ADR-043: Resource Versioning and Row-Level Diff (DuckLake)

## Status

**Proposed**

Introduces versions for canonical resource data and, for tabular resources, provides
row-level diffs between versions, time travel, and column schema change history.
Adopts DuckLake as the table format (catalog = existing PostgreSQL).

## Context

Today, a resource's canonical file is uploaded by **overwriting** a fixed storage key
(`resources/{packageId}/{resourceId}`, `getStorageKey()`), so previous versions are lost.
The preview Parquet (ADR-014 / ADR-029) is also a disposable derivative regenerated
wholesale from the latest version. There is **no way — in metadata or in the data
itself — to answer "what changed in the last update of this dataset?"**

CKAN is similarly weak on resource history: old data disappears on every update (or
users manually keep "2024 edition" / "2025 edition" as separate resources). For
periodically updated open data (facility lists, statistics, budgets, etc.), there are
clear needs:

1. **Administrators** want to check how many rows were added/removed and whether columns
   changed on update (quality management, auditing)
2. Presenting "changes since the previous version" to **viewers** also has value
   (transparency of updates)
3. Tracking **column schema evolution** (columns added/removed, type changes)

As an extension of ADR-032's shift toward "a data platform that AI can autonomously
explore and aggregate," this ADR aims to **make versions and diffs first-class citizens**.

### Current state this builds on

- Schema is persisted for the **latest version only**, in `resource_pipeline.metadata.schema`
  (ADR-032 Part A)
- Server-side queries rely on a strong sandbox: materialize Parquet in memory, then fully
  disable external access (ADR-032 Part B). This isolation model is preserved
- S3 versioning is enabled (for backup; noncurrent versions expire after 30 days, ADR-037),
  but the app layer never handles `VersionId`, so it **cannot serve as app-level
  versioning** (see option D below)

## Options Considered

### How to implement versions

- **A) DuckLake (adopted)**: A table format that stores metadata (snapshots, file lists,
  delete information, statistics) in a SQL database, so the **catalog can live in the
  existing PostgreSQL** — no new infrastructure. Provides snapshots, time travel,
  `table_changes()` (row-level CDC), and column schema evolution out of the box.
  v1.0 (April 2026) is a production-ready spec with backward-compatibility guarantees;
  catalogs support SQLite / PostgreSQL / DuckDB, with Iceberg-compatible delete vectors.
  KUKAN already runs DuckDB on both server and browser (ADR-016 / ADR-032), so the
  stack addition is minimal.
  See: <https://ducklake.select/> / <https://duckdb.org/docs/stable/core_extensions/ducklake>
- **B) Apache Iceberg / Delta Lake**: Industry standards, but they require operating an
  additional catalog (REST catalog / Hive metastore, etc.) and metadata resolution
  involves multi-hop file reads. Bringing extra components into on-premises / air-gapped
  deployments also conflicts with the "no more adapters" philosophy (ADR-005).
- **C) Versioned row data in PostgreSQL (CKAN DataStore style)**: A versioned variant of
  the approach rejected in ADR-032. Heavy with variable schemas and many resources;
  bloats the database. Rejected.
- **D) Reusing S3 object versioning**: Already enabled, but it is a **backup mechanism**
  (noncurrent expiry after 30 days; not configured on on-prem MinIO) and cannot serve as
  a foundation for listing, referencing, or diffing versions. Not used for app-level
  versioning.
- **E) File-level version retention only (no DuckLake)**: Just keep immutable version
  files. Minimal implementation, but yields no row-level diff or schema history, failing
  most of needs 1–3. However, this is **included as-is as the foundation (Layer 1) of A**.

### Row-level diff semantics

- **A) Three-tier fallback (adopted)**: Degrade diff granularity based on key presence and
  schema changes (Decision §3). When there is no key, do not force row matching —
  **never fabricate change history from guesses**.
- **B) Attempt row-hash matching for all resources**: Could always estimate "changed rows,"
  but without keys, changes cannot be distinguished from add+delete pairs, risking
  presentation of incorrect history. Rejected.

## Decision

**Introduce versions and diffs in a three-layer structure.**

```
Layer 1: Canonical version files (all formats)
         versions/{packageId}/{resourceId}/v{n} — immutable, tracked by resource_version table
Layer 2: DuckLake (tabular resources only)
         1 resource = 1 table. Row-level diff, time travel, column schema history
         Catalog = existing PostgreSQL; data files = existing S3/MinIO
Layer 3: Preview Parquet (unchanged)
         No change for now. Future replacement with "export from latest DuckLake
         snapshot" is an open issue
```

**DuckLake (Layer 2) is positioned as a derived index that can always be rebuilt from
Layer 1.** The canonical source is the Layer-1 version files; the DuckLake catalog and
data files can be regenerated by reprocessing all resources. This keeps format risk
(migration, corruption) in the same class as the preview Parquet.

### 1. Layer 1 — Canonical version files

1. **All formats are covered** (including PDF, images, ZIP, etc.). Even for non-tabular
   data, "when, by whom, replaced with what" history is meaningful.
2. On upload (replacement), in addition to writing to the current key
   `resources/{packageId}/{resourceId}`, **store the same content immutably** at
   `versions/{packageId}/{resourceId}/v{n}`. The current key continues to serve as
   "latest," so existing download / preview / pipeline paths work unchanged.
3. Add a `resource_version` table (managed by Drizzle):
   - `id` (UUID), `resource_id` (FK), `version` (sequential), `storage_key`, `size`,
     `hash`, `origin` (`upload` | `fetch`), `state` (`active` | `purging` | `purged`),
     `created_by`, `created` / `updated`
   - Also associates a snapshot of the column schema (the version's equivalent of
     `metadata.schema`) and the Layer-2 snapshot ID (tabular only, see below)
4. **Replacements with identical content do not create a version**: if the hash matches
   the previous version, only update a verification timestamp.

### 2. External URL resources — observation-based versions

Version semantics differ between uploads and external URLs. A version of an external URL
resource is an observation — "**this is how it looked at fetch time**" — with no guarantee
of capturing every upstream change.

1. When the pipeline Fetch runs (manual reprocess; scheduled re-fetch in the future),
   store the content as `v{n}` in Layer 1 **only if its hash differs** from the previous
   version (hash gate). If identical, only update the verification timestamp.
2. Set the version's `origin` to `fetch`, and make clear in UI / API that it is a
   "snapshot as observed at fetch time" (avoid misleading users into reading it as a
   complete history).
3. Scheduled re-fetch is out of scope for this ADR. A natural future extension is to
   piggyback change detection on the quality package's link monitoring (which already
   crawls external URLs periodically) — an open issue.

### 3. Layer 2 — DuckLake and row-level diff

1. **Topology**: The catalog lives in a dedicated schema (e.g., `ducklake`) inside the
   existing PostgreSQL. Catalog tables are managed by the DuckLake extension and are
   **excluded from Drizzle migrations**. Data files live under a dedicated prefix
   (e.g., `lake/`) in the existing bucket.
2. **Writes are worker-only**, serialized per table. Do not bring DuckLake write paths or
   additional native-dependency load into the web process (same placement judgment as
   ADR-032). Code touching DuckLake is isolated in a dedicated module; no other code
   calls the DuckDB API directly.
3. **DuckDB reads and writes storage directly** (httpfs / S3 API). This bypasses the
   storage adapter, but only for derivatives under the `lake/` prefix (not a contradiction
   of ADR-005's "adapters absorb environment differences only" — the S3-compatible API
   itself absorbs the environment difference here).
4. **1 resource = 1 table**. Add a Version step to the pipeline and ingest using the
   Extract type-inference results (ADR-029) as column types. Start with the same targets
   as current Parquet generation: **CSV / TSV, ≤50MB** (raising the limit is an open issue).
5. **Snapshot mapping**: DuckLake snapshots increase monotonically catalog-wide, so record
   the snapshot ID obtained at each commit in `resource_version`, maintaining the
   "resource version ↔ DuckLake snapshot" mapping on the KUKAN side.
6. **Diff extraction uses a three-tier fallback**:
   - **With a key** → row-level diff via `MERGE`. Added, deleted, and **changed** rows are
     distinguished, with minimal-cost history. The key column is optionally designated by
     an administrator in resource settings (v1 is manual only; AI-suggested key candidates
     are a future extension of the ADR-040 suggestion infrastructure).
   - **Without a key** → full replacement + statistical summary ("x rows added, y rows
     deleted out of N"). Row correspondence is judged only by exact row-content hash
     matches, and **"changed row count" is never reported** (without a key, changes cannot
     be distinguished from add+delete; do not fabricate change history from guesses).
   - **Schema change** (columns added/removed, type change) → abandon row diff; record a
     new version + the schema change.
7. **Column schema history (need 3)**: The DuckLake catalog retains column additions,
   deletions, and type changes with snapshot boundaries, so schema evolution of tabular
   resources is queryable with no extra implementation.
   `resource_pipeline.metadata.schema` remains the "latest version cache" as before.
   For non-tabular resources, Layer 1 (version, size, hash, timestamps) suffices as
   change history.

### 4. Exposure paths and sandbox separation

The ADR-032 sandbox (in-memory materialization → total external-access lockdown) is
**preserved unchanged**. Paths are strictly separated by whether they may touch DuckLake:

| Path                                   | SQL origin                                                                           | DuckLake access                            |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| Version list / diff API (new)          | **Server-composed fixed queries only** (parameters limited to version numbers, etc.) | Yes                                        |
| `/query` / `query_resource` (existing) | Raw SQL from users / AI                                                              | **No** (materialize → lockdown, as before) |

- New APIs (draft): `GET /resources/{id}/versions` (version list),
  `GET /resources/{id}/diff?from=&to=` (added/deleted/changed row counts, schema diff,
  sample rows). Visibility checks go through the same path as ADR-017 / ADR-032.
- The existing query path is extended only to "when a `version` parameter is given,
  materialize that version's Parquet." User SQL never touches the DuckLake catalog or
  data files.
- The primary consumer of diffs is administrators (quality management, auditing), but
  diff summaries of public resources are also shown to viewers (version visibility equals
  the resource's own). MCP tooling (`get_resource_diff`, etc.) will be added based on
  demand (open issue).

### 5. Purge (legal deletion)

Complete deletion of a specific version. A mechanism to **destroy the content of past
versions** (licensing issues, personal data, mistaken publication, etc.), independent of
normal deletion (resource delete).

1. **Restricted to sysadmin**. A reason is required and recorded in the audit log.
2. **Tombstone model**: The `resource_version` row remains (when, by whom, why purged);
   only the content is removed from all affected locations.
   Asynchronous transition `state: active → purging → purged` (following the ADR-028
   durable-claim pattern, executed by the worker).
3. **Affected locations**:
   - Layer 1: delete the version file (`versions/.../v{n}`)
   - Layer 2: expire the relevant snapshots → **rewrite (compaction rewrite)** the files
     containing the targeted data → physically delete the old files. Note that data files
     are physically shared between versions, so expiry alone does not remove the data.
     Time travel to the purged versions becomes impossible (which is the point)
   - Derivatives: the preview Parquet derived from that version, and the OpenSearch
     resource-content index (ADR-021, when the purged version is the latest)
4. **Physical destruction timeline** (AWS): On purge, the content becomes immediately
   invisible to the app layer (all roles). S3 noncurrent versions expire via lifecycle
   (30 days, ADR-037), and AWS Backup recovery points disappear when their retention
   expires. **State explicitly in the spec: "after a purge, physical destruction completes
   within at most 30 days plus the backup retention period."**
   During the residual window, no code path in the app reaches noncurrent versions — no
   KUKAN role can access them (only infrastructure operators holding AWS IAM can).
   On-prem (MinIO without versioning), deletion is immediate and no residue exists (note
   that backup handling depends on the deploying organization's operations).

### 6. Operations — compaction and snapshot retention

1. **Compaction**: Read performance is dominated by file count, so a periodic worker
   maintenance job consolidates files. **The latest version is guaranteed to be
   compacted**; historical versions may remain fragmented.
2. **Snapshot / version retention count**: Held as a runtime system setting (ADR-036),
   changeable by sysadmin (default unlimited; expected operation is to tighten it when
   storage pressure rises). Expiring old snapshots and cleaning up orphaned files run in
   the same maintenance job.

## Consequences

- **DB**: Adds the `resource_version` table (Drizzle). A DuckLake catalog schema is added
  inside the same PostgreSQL (managed by the DuckLake extension, outside Drizzle)
- **Worker**: Adds a Version step to the pipeline (Layer-1 storage, hash gate, DuckLake
  ingest, diff extraction). Adds maintenance jobs for compaction / expiry / purge
  execution. `@duckdb/node-api` becomes a worker dependency as well
- **API**: Adds routes and services for version listing, diff, and purge. Extends the
  existing `/query` with a `version` parameter. No DuckLake write path is added to the
  web process
- **Storage**: `versions/` grows linearly with version count (controlled by the retention
  setting). `lake/` grows at diff cost (unchanged files are physically shared between
  versions)
- **Security**: SQL touching DuckLake is server-composed only. The ADR-032 sandbox is
  unchanged. Purge is sysadmin-only + audit-logged
- **Backward compatibility**: Existing resources get v1 at their next replacement (no bulk
  backfill, same policy as ADR-029 / ADR-032). Existing download / preview paths are
  unchanged

## Open Issues

1. **Scheduled re-fetch**: Piggyback external-URL change detection on the quality
   package's link monitoring and enqueue re-fetch on change
2. **Expanding coverage**: Raising the DuckLake ingest limit (currently ≤50MB, same as
   Parquet generation) and covering JSON etc. (same root as ADR-032 open issue 1)
3. **Multi-site (ADR-041)**: Per-site DuckLake catalogs vs. a single catalog + table-name
   prefix. Counting catalog connections against the connection budget
4. **Preview Parquet consolidation (Layer 3)**: Replace previews with "exports of the
   latest DuckLake snapshot" to unify the generation path
5. **MCP tooling**: `get_resource_diff`, version-aware `query_resource`, and other
   version/diff access for AI agents
6. **AI key suggestion**: Add primary-key candidate suggestion to the ADR-040 suggestion
   infrastructure to help resources graduate to keyed diffs (the MERGE tier)
7. **IAM hardening**: Explicitly deny `s3:GetObjectVersion` / `s3:DeleteObjectVersion` on
   task roles so that noncurrent versions during the purge residual window are blocked at
   the IAM level too (currently blocked only by the absence of code paths)
8. **Iceberg export**: Provide public snapshots in Iceberg format (direct reads from
   external engines). DuckLake's Iceberg-compatible delete vectors keep conversion cost
   limited

## Related ADRs

- ADR-005: Only four adapters (DuckLake is not adapterized; direct storage access is an
  exception limited to the `lake/` prefix)
- ADR-014 / ADR-016 / ADR-029: Preview Parquet, DuckDB explorer, column type inference
  (foundations that Layer-2 ingest builds on)
- ADR-017: Server-proxied download / preview URLs (visibility-check approach followed)
- ADR-021: Resource content full-text search (purge propagation target)
- ADR-028: Asynchronous organization purge with durable claim (purge state-transition
  pattern followed)
- ADR-032: MCP data query foundation (premise of the sandbox separation; schema
  persistence is extended to per-version snapshots by this ADR)
- ADR-036: Runtime system settings (retention count)
- ADR-037: Backup strategy (S3 versioning; basis of the physical-destruction timeline)
- ADR-040: AI metadata suggestion (future extension for key-column candidates)
- ADR-041: Multi-site deployment (open issue on catalog partitioning)
