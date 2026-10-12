# ADR-067: Make the Layer 2 Catalog a File per Resource, and Purge by Rebuilding

## Status

**Accepted** — 2026-10-12 (proposed 2026-10-12), not yet implemented

Move the DuckLake catalog from one PostgreSQL schema (a single catalog for everything) to **a
SQLite file per resource**, kept under the same `lake/<resourceId>/` prefix as its data. Snapshot
numbers then stay inside one resource, so a version purge can **again claim the bytes are erased**,
by "discarding that resource's layer 2 and re-ingesting the remaining versions from layer 1". This
restores the guarantee ADR-043 §5 narrowed in ii-b, closes open issue 3 (multi-site), and
overturns the settlement of open issue 7 ("a fine-grained purge cannot work, so narrow what the
purge claims").

The position of layer 2 as "a derived index that can always be rebuilt from layer 1" (the opening
of ADR-043's decision) does not change. The serving paths (preview Parquet, ADR-032 / ADR-055) are
not touched.

> **This ADR is a draft written with Claude Code from a design conversation, then checked against
> the v0.34.0 source (`490944dd`) and the official documentation.** The touch points and numbers
> come from the source. The spike (decision 7, `spike/adr-067/`) was run on 2026-10-12; the results
> are under "Measurements" in decision 7.

## Context

### 1. The container is catalog-sized

DuckLake snapshots form one monotonically increasing sequence across the whole catalog. The data
files of version v3 of resource A are visible from **every** snapshot between "A's v3 commit and its
v4 commit", and if another resource B committed in between, a B version row names that snapshot.
So A's v3 alone cannot be expired. ADR-043 §5.1 calls this "the container principle", and
`packages/lake/src/__tests__/purge.ducklake.test.ts` pins it ("leaves one table’s rows on the disk
because another table needs the snapshots").

Because of this, ADR-043 accepted the following in ii-b.

- **Layer 2 does not guarantee erasure of bytes** (§5). It only makes them unreachable by nulling
  `ducklake_snapshot_id`, and the term "legal deletion" was dropped
- **Expiry uses an explicit list** (§6-4). Because IDs are catalog-wide, `older_than` cannot be
  used; every time, `reclaimInSession` (`packages/api/src/services/lake/lake-reclaim.ts`) collects
  "the IDs referenced by versions not purged" **across all resources**, and
  `reclaimUnreferencedSnapshots` (`packages/lake/src/maintenance.ts`) passes the complement to
  `ducklake_expire_snapshots(versions => [...])` → `ducklake_cleanup_old_files(cleanup_all => true)`
- **Writes to layer 2 are serialised across the whole catalog.** Ingest, the purge's stand-down and
  the reclaim run under the global advisory lock `LAKE_INGEST_LOCK`
  (`packages/api/src/services/concurrency/advisory-lock.ts`) — because the snapshot sequence and
  the reclaim's set computation span resources
- **A fine-grained purge (step back to the previous version and re-ingest only later versions)
  cannot work** (the settlement of open issue 7). Even if the re-ingest writes new files, the old
  files are still held by snapshots retained for other resources
- **Multi-site** (open issue 3) has not decided whether to split the catalog. In practice each
  site has its own PostgreSQL database (ADR-041, `infra/lib/lambda/site-db-handler`), so each
  site's database has a `ducklake` schema of the same name

### 2. Purges need to be complete

In government open data, past versions have to be **erased** because of mistaken publication,
personal information mixed in, or licence violations. "Made unreachable" is hard to defend in an
audit. The current position — "do not report as 'deleted' what has not disappeared" (§5) — is
honest, but it does not solve the inability to erase.

### 3. Layer 2 is used as a ledger

As of v0.34.0, the only readers of DuckLake tables are version diffs (`runDiff` → `diffVersions`
in `version-diff-service.ts`, fixed queries built by the server) and the worker's own reads during
ingest and stand-down. `query_resource`, OData and previews read the preview Parquet (`previewKey`
in `query-service.ts` / `odata-service.ts`). The primary-key pre-check (`checkKeyAgainstPreview`)
also opens a lake session through `scanLake`, but what it reads is the preview Parquet, not the
catalog. **The version list comes from `resource_version` (PostgreSQL) and does not read
DuckLake.**

Cross-catalog queries are not asked of layer 2 (ADR-043 §4). **Nothing uses the properties a single
catalog provides — "read every table at the same snapshot", "see everything with one ATTACH".**

### 4. One writer at a time per resource

The paths that write to layer 2 are exhausted by the following (v0.34.0).

| Path                                      | Entry point                                                                                | What it does to layer 2                                                                                         | Claim (ADR-044)          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Pipeline Lake step                        | `steps/lake.ts` → `ingestVersionIntoLake` → `ingestParquetVersion`                         | `CREATE TABLE AS` / keyed `MERGE INTO` (`keyed-load.ts`) / full replace / `CREATE OR REPLACE` when columns move | `run`                    |
| Re-ingest (`lake-ingest-version`)         | `retry-lake-ingest.ts` (queued on failure, by the hourly sweep, and by version migrations) | Same                                                                                                            | `job`                    |
| Version purge (`purge-resource-version`)  | `purgeFromLake` in `resource-version-service.ts`                                           | `DROP TABLE` or `restandLakeTable` (a reload not recorded on version rows), then the reclaim                    | `job`                    |
| Package / draft purge                     | `package-service.ts` → `drop-lake-tables` job → `dropPurgedLakeTables`                     | `DROP TABLE` + reclaim                                                                                          | none (rows already gone) |
| Organisation purge (`purge-organization`) | `purgeDeletedOrg` in `organization-service.ts`                                             | `dropResourceTables` + `reclaimLakeStorage`                                                                     | `job`                    |
| Orphan cleanup (hourly cron)              | `sweep-lake-orphans.ts` → `deleteOrphanedFiles`, `queueStrandedLakeTables`                 | `ducklake_delete_orphaned_files`, re-queues drops for stranded tables                                           | —                        |
| Every session open (web included)         | `disableDataInlining` in `connection.ts`                                                   | Writes `data_inlining_row_limit` via `set_option` if it is not 0                                                | —                        |
| Admin "delete all data"                   | `routes/admin.ts` (`DELETE /api/v1/admin/data`)                                            | Deletes the `lake/` prefix, and `DROP SCHEMA ducklake CASCADE` from the PostgreSQL side                         | —                        |

Every path that rewrites a given resource's layer 2 runs under the ADR-044 execution claim (the
package / draft purges run after the rows are gone, so there is nobody to contend with).
**Optimistic locking of the catalog and arbitration between writers are unnecessary once the
catalog is per resource.** The global lock that does that job today exists because the catalog is
shared (context 1).

### 5. Only tabular resources have layer 2

The Lake step (`apps/worker/src/pipeline/steps/lake.ts`) is called only when Interpret has written
a local table (the `onTable` hook in `steps/interpret.ts`, which returns early for formats that do
not pass `isTableSourceFormat`), and does not decide format itself. The re-ingest job passes the
same gate — `pendingLakeIngestQuery` (`resource-version-service.ts`), which selects its targets,
filters by table-source format (`TABLE_SOURCE_FORMATS`) and the size limit, re-interprets through
`withInterpretedVersion`, and ingests only when a table comes out.

What produces a table is, of `TABLE_SOURCE_FORMATS = ['csv', 'tsv', 'json', 'geojson']`
(`packages/shared/src/formats.ts`), CSV/TSV and JSON/GeoJSON that read as a list of records
(ADR-063 decision 10). **XLSX does not become a table** — ADR-057, which would interpret plain-table
XLSX as a table, is still a proposal, and XLSX goes only through the document-text path. PDF, Office
documents, Ichitaro, Markdown, images and ZIP stop at layer 1's version file and the document-text
artifact (`text.ndjson.zst`), and never touch DuckLake. **This ADR also covers tabular resources
only.**

### 6. Traces of DuckLake in PostgreSQL and around it

The `ducklake` schema is created and managed by the DuckLake extension itself through
`ATTACH 'ducklake:postgres:...' (METADATA_SCHEMA 'ducklake')`, and is not a Drizzle migration
target (ADR-043 §3-1). Moving the catalog out of PostgreSQL touches exactly these traces.

- **Six columns and one partial index on `resource_version`**
  (`packages/db/src/schema/resource-version.ts`): `ducklake_snapshot_id`, `lake_key_columns`,
  `lake_ingest_reason`, `lake_ingest_queued_at` (the sweep's lease), `lake_ingest_failures`,
  `lake_ingest_failed_at` (ADR-043's `ingest-failed`), and `idx_resource_version_pending_lake`.
  **Only `ducklake_snapshot_id` changes meaning in this ADR**; the rest are used as they are
- **`resource.column_settings`** (the primary-key setting, frozen into `lake_key_columns` when a
  version is created). Unchanged
- **Job types** `lake-ingest-version` and `drop-lake-tables` (`pipeline-types.ts`)
- **The schema-name constant** `LAKE_METADATA_SCHEMA = 'ducklake'` (`packages/lake/src/config.ts`),
  the ATTACH that uses it (`connection.ts`), and **the admin route's
  `DROP SCHEMA IF EXISTS ducklake CASCADE`** (`routes/admin.ts`, delete all data)
- **The catalog connection budget** `WEB_LAKE_CATALOG_CONNECTIONS = 1` /
  `WORKER_LAKE_CATALOG_CONNECTIONS = 2` (`packages/shared/src/lake-limits.ts`). `lake-scan.ts` and
  the worker's `index.ts` pass them to `pg_pool_max_connections`, and `infra/lib/config.ts` adds
  them to the per-task connection count checked against `max_connections`
  (`synth-multi-site.test.ts` pins the formula). They are not environment variables
- **Bundled DuckDB extensions**: both the web and worker stages of the `Dockerfile` put `httpfs`,
  `aws`, **`postgres`** and `ducklake` in `DUCKDB_EXTENSION_DIRECTORY`, and `connection.ts` loads
  the same four. **The `postgres` extension is there only for the catalog**
- **Documentation**: the system administrator guide (ja/en) says "the diff catalog lives in a
  `ducklake` schema of the same PostgreSQL database"; the multi-site guide and
  `docker/multi-site/README.md` break down the catalog connections

The tests already do not use PostgreSQL. The `*.ducklake.test.ts` files (four: ingest / merge /
maintenance / purge) use a local DuckDB file as the catalog
(`ATTACH 'ducklake:<dir>/catalog.ducklake'`).

## Options Considered

### A) Keep as is (single catalog, only make unreachable) — rejected

This gives up on complete purges. It cannot answer the requirement in context 2.

### B) A catalog per dataset (package) — rejected

It matches the unit of visibility and of package purge, and the number of PostgreSQL schemas stays
within `#datasets`. But **other resources of the same dataset hold on**, so the container principle
does not go away. Datasets lined up with per-year CSVs are common, and there it is in the same state
as A. Even if a single ATTACH is wanted for future JOINs, real-world joins cross datasets (facility
list × population by district), so a per-dataset unit gains little. Half-way for either purpose.

### C) Per resource, catalog as a PostgreSQL schema — rejected

The container matches the resource and the purge works. But a DuckLake catalog creates over a dozen
tables per `METADATA_SCHEMA`, so a prefecture site with tens of thousands of tabular resources ends
up with hundreds of thousands of tables. Even with one database per site (ADR-041) they sit on the
same instance and add up. This affects `pg_catalog` bloat, autovacuum, and backup/restore time. The
catalog connection budget also remains.

### D) Per resource, catalog as a DuckDB file (on S3) — rejected (runner-up, re-judged by the spike)

The schema-count problem disappears, and since it is exactly what the tests use today
(`ducklake:<path>`), no extension is added.

The draft rejected this because the file format has no forward compatibility; **that was wrong**.
From 1.0 through 1.5, DuckDB writes new files with storage version `v1.0.0` by default, and older
1.x can read them ("Forward compatibility is provided on a best effort basis"; only raising
`STORAGE_VERSION` locks older versions out —
<https://duckdb.org/docs/current/internals/storage.html>,
<https://duckdb.org/docs/current/sql/statements/attach.html>). What matters on rollback is rather
**the DuckLake catalog version**, and that is the same for D and E (decision 1).

The remaining differences are these, none of them decisive.

- **Size**: a DuckDB file grows in 256 KiB blocks by default (`BLOCK_SIZE` default 262144), so even
  with few rows a catalog grows large. Measured with 50 versions and 97 files, the catalog is
  **4.5 MB as a DuckDB file and 188 KB in SQLite** (about 1/24, decision 7). It is downloaded for
  every diff, so the difference counts
- **Readable without DuckDB**: for audits and incident investigation it opens with the sqlite3 CLI
  or Python's standard library. Tests can check "no purged file is listed in the catalog after a
  purge" without going through DuckDB
- **Official positioning**: a DuckDB catalog is "limited to a single client", SQLite is for
  "multiple local clients"
  (<https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database>). KUKAN downloads
  and opens the file each time, so either is one client

The spike found no SQLite-specific defect, and ATTACH time was the same (around 4 ms). Writes are
slower with SQLite (ingesting 50 versions took 16 s against 9 s), but that is the time of a rare
operation, the rebuild for a purge, and weighs less than the size difference paid on every diff
download. **E is adopted.** Decisions 2–6 are the same either way.

### E) Per resource, catalog as a SQLite file (on S3) — adopted

D's advantages (no schema count, no connection budget) plus the three points above.

The cost is bundling DuckDB's `sqlite` extension. But **the `postgres` extension, which exists only
for the catalog, is no longer needed**, so the number of extensions shipped pinned through
`DUCKDB_EXTENSION_DIRECTORY` for closed networks stays the same (`httpfs`, `aws`, `sqlite`,
`ducklake`).

### Note: why not Iceberg

Turning the catalog into files weakens ADR-043's argument that "new infrastructure is needed"
(KUKAN's `resource_version` pointing at the metadata location would be the catalog). DuckLake is
kept anyway because **the writer lives in the current runtime (the worker's DuckDB node-api,
1.5.5)**.

DuckDB writes to Iceberg **only when an Iceberg REST catalog is attached**. "Writing to a table read
directly from storage with iceberg_scan is not supported", "the catalog is required to commit the
new table metadata"
(<https://duckdb.org/docs/current/core_extensions/iceberg/writing_to_iceberg.html>), "Attaching a
catalog is required for writing to Iceberg"
(<https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html>). No filesystem / hadoop
catalog is documented. The available operations have been filling in (`CREATE TABLE` and `INSERT`
in 1.4.0, `UPDATE` and `DELETE` in 1.4.2, `MERGE INTO` and `ALTER TABLE` in 1.5.3 —
<https://duckdb.org/2025/11/28/iceberg-writes-in-duckdb.html>,
<https://duckdb.org/2026/05/29/new-iceberg-features>), but only merge-on-read, and updates and
deletes on sorted tables are not supported.

So Iceberg would mean bundling and operating a REST catalog (Polaris, Lakekeeper, etc., or AWS
Glue / S3 Tables), which under a TypeScript-only monorepo and closed-network distribution weighs
the same as "new infrastructure". Iceberg is kept as an outbound form (the export in ADR-043 open
issue 9). Layer 2 can be rebuilt, so this decision can be reversed later.

## Decision (Proposed)

### 1. Where the catalog lives

- 1 resource = 1 catalog = 1 SQLite file. The table name stays `lakeTableName(resourceId)` (the
  catalog holds only one, but there is no reason to rename it either)
- The layout cuts **generations** under `lake/<resourceId>/`:

  ```
  lake/<resourceId>/<generation>/catalog.<token>.sqlite   ← a new key on every commit
  lake/<resourceId>/<generation>/data/                    ← DuckLake's DATA_PATH
  ```

  - **The catalog is written to a new key on every commit.** Overwriting would leave old catalogs
    (whose column statistics hold the values themselves) as S3 versioning's noncurrent versions,
    which contradicts the purpose of this ADR. The same rule as "version keys do not move"
    (ADR-043 §1-2)
  - **The catalog sits outside `DATA_PATH`.** `ducklake_delete_orphaned_files` deletes "files the
    catalog does not know" under `DATA_PATH`, so putting it there could have the catalog itself
    read as an orphan (checked by the spike, decision 7-6)
  - **The generation changes on every rebuild for a purge (decision 4).** Ordinary ingests add to
    the same generation. Old generations can be deleted by prefix, with no need to match data files
    one by one

- There is **one current catalog key per resource**, so add `lake_catalog_key` to
  `resource_pipeline` (the draft put it on `resource_version`, but since every ingest moves the
  catalog to a new key, older version rows would point at reclaimed keys). It is the same table as
  the derivative pointers (`preview_key` etc.), and the claim lives there. It is not added to
  `pipelineObjectKeys` (the derivatives a live-version purge discards), though — layer 2 is rebuilt,
  not discarded
- `resource_version.ducklake_snapshot_id` keeps its meaning as **a number within the resource**. The
  other five columns and the partial index do not change
- **The PostgreSQL `ducklake` schema is no longer needed.** Being outside Drizzle, it is dropped
  after migration with `DROP SCHEMA ducklake CASCADE`, spelled out in the operating procedure
  (system administrator guide). `DROP SCHEMA` also leaves the admin "delete all data" (deleting the
  `lake/` prefix is enough). With the libpq catalog connections gone, remove the two constants in
  `lake-limits.ts`, the connection-budget addition in `infra/lib/config.ts`, the formula in
  `synth-multi-site.test.ts`, and `LAKE_METADATA_SCHEMA`, and swap the bundled `postgres` extension
  for `sqlite`
- A SQLite file cannot be opened directly on S3 (DuckDB's `sqlite` extension opens local files; the
  DuckLake docs do not mention where it may live), so **both reads and writes download it locally
  first**
- **Data inlining is turned off when the catalog is created.** From DuckLake 1.0 (bundled with
  DuckDB 1.5.2), inlining is on by default (10 rows)
  (<https://ducklake.select/2026/04/13/ducklake-10/>,
  <https://ducklake.select/docs/stable/duckdb/advanced_features/data_inlining>). `set_option`
  persists ("Configuration is persisted in the ducklake_metadata table",
  <https://ducklake.select/docs/stable/duckdb/usage/configuration>), so it stays in the catalog. Write
  it once right after creation, and **restrict today's `disableDataInlining`, which checks and writes
  on every session open, to the worker's ingest** (the web only reads a downloaded catalog, and
  anything it wrote would be thrown away)
- **Migrating the DuckLake catalog version.** From DuckLake 1.0, opening a catalog with a newer
  extension no longer migrates it automatically (ATTACH's `AUTOMATIC_MIGRATION` defaults to
  `false`, <https://ducklake.select/docs/stable/duckdb/usage/connecting>). With a single catalog the
  migration happens once; per resource it is **tens of thousands of files**. Layer 2 can be rebuilt,
  so a release that raises the catalog version would by default run the rebuild of decision 6.
  Rolling back is then just a setting, provided the old catalogs are kept until confirmed (open
  issue 6)
- Non-tabular resources get no `lake/<resourceId>/` (context 5). Even within one resource, whether
  a version read as a table can change between versions (a broken CSV, a change in JSON structure, a
  corrected format label). Only versions that read as tables go into layer 2; the others keep a null
  `ducklake_snapshot_id` and exist only in layer 1 — as today

### 2. Ingest

The body of today's `ingestVersionIntoLake` (`ingestParquetVersion`, keyed `MERGE INTO`, 1 version =
1 snapshot) stays; what surrounds it changes.

1. Download the catalog at `resource_pipeline.lake_catalog_key` (if there is none, create one in a
   new generation and turn inlining off). ATTACH the local path with `ducklake:sqlite:`, pointing
   `DATA_PATH` at that generation's `data/`
2. Ingest (as today)
3. DETACH so that the journal is folded into the main file, and PUT it to a new key. **The PUT goes
   through write-ahead recording** (ADR-045). A catalog from an attempt that died before its rows
   were written expires with zero references and the sweep deletes it
4. In one transaction, write the version row's `ducklake_snapshot_id`, move `lake_catalog_key` to
   the new key with a CAS (failing if the original key changed), and park the old catalog key for
   reclaim

Ingest already runs under the claim (`run` / `job`), so **concurrent writes to the same resource do
not happen. The global `LAKE_INGEST_LOCK` is no longer needed for layer 2.** What the lock guards
today is "another run cutting in between reading the base and committing" (the note in
`purgeFromLake`), and the only ones that can cut in are writers of the same catalog. Whether to
remove it is decided during implementation, after checking that the lock guards no other invariant.

SQLite's journal mode stays the default rollback journal, so that the main file is consistent even
if a write dies midway. **The local file of an attempt that died is discarded, never used.** Dying
during a commit leaves a hot journal (`-journal`), and the main file is consistent only together
with it (measurement 3 in decision 7). Only a file that has been DETACHed is PUT, and the next
attempt always downloads afresh from S3. Parquet from a failed attempt remains as an orphan in the generation's
`data/`, and the `ducklake_delete_orphaned_files` cron deletes it as today (the cron would then run
per catalog; whether running it only for resources whose ingest failed, rather than hourly over all
of them, is enough is decided during implementation).

### 3. Reads

- Diffs: download the file at `lake_catalog_key`, ATTACH it (read-only), and open both ends with
  `AT (VERSION => n)` (`diffVersions` unchanged). Only one resource is opened, so this is lighter than
  today. Keys are never rewritten, so the web may lru-cache files by key (ADR-004)
- The primary-key pre-check (`checkKeyAgainstPreview`) reads only the preview Parquet, so make it
  not open the catalog
- The only path that uses the web's DuckDB slot (`withDuckdbSlot`, which `lake-scan.ts` shares with
  ADR-032 queries) becomes the diff

### 4. Purge (rebuild)

Change how a version purge reaches layer 2 from "stand-down (`restandLakeTable`) + unreachability +
best-effort reclaim" to **a rebuild**. **The state transitions and the claim stay as they are**; only
the body of `purgeFromLake` is replaced.

Today's flow (`resource-version-service.ts`, the ADR-043 §5 / ADR-028 pattern):

1. The API's `claimPurge` moves the row `active → purging` and, in the same transaction, queues
   `purge-resource-version` (no resource claim taken). There is one `purging` row per resource
   (`idx_resource_version_one_purging`)
2. The worker's `executePurge` runs `purgeVersion` under **`withResourceClaimsOrConflict` (kind
   `job`)**. If the claim cannot be taken, it fails with a `ConflictError` and the queue retries
3. `purgeVersion`: delete the layer 1 version file (**deletion first**) → if it is the live version,
   discard derivatives and the content index and set `purgeRebuildPending` → **`purgeFromLake`** →
   point live back at the highest remaining version (or empty it) → queue a `rebuildOnly` pipeline
   → tombstone (`purged`, `ducklake_snapshot_id = null`)
4. If it dies midway, the row stays `purging`. Queue redelivery or the hourly `queueStrandedPurges`
   re-queues it. Each step is idempotent

The new `purgeFromLake` (under the claim, after the layer 1 deletion):

1. **Rebuild.** If the version being purged was not in layer 2 (`ducklake_snapshot_id` is null),
   skip this step. If it was, re-ingest from layer 1, **in version order**, **the versions other
   than `purged` / `purging` whose `ducklake_snapshot_id` is non-null**, into a catalog in a new
   generation. Interpretation goes through `withInterpretedVersion` (ADR-046) as ingest does, and
   each version MERGEs with its frozen `lake_key_columns`, so the ii-b history is reproduced too. The
   targets are "versions that were in layer 2" rather than "versions that interpret as tables" so as
   not to mix in versions left out for key faults (`lake_ingest_reason`), and to leave versions not
   yet ingested to the sweep as now. If no version remains, no catalog is created
2. **Swap.** PUT the new catalog (write-ahead), and in one transaction renumber the remaining
   versions' `ducklake_snapshot_id`, **null the purged row's `ducklake_snapshot_id`**, and move
   `lake_catalog_key` to the new key (null if no version remains). The purged row is nulled before
   the tombstone so that a retry does not repeat step 1 (renumbered IDs can collide with the old
   catalog's)
3. **Delete old generations.** Delete, by prefix, every generation under `lake/<resourceId>/` other
   than the current one. **This step runs every time, including when step 1 was skipped**, so a
   retry after dying right after step 2 completes here. The old catalog is deleted immediately
   rather than parked for reclaim (parking would leave its column statistics around for 1 hour plus
   the sweep interval)

Today's three branches (`stays` / `drop` / `onto`) and the reclaim (`reclaimInSession`) are no
longer needed. In the rebuilt catalog, the table's current contents are the last version ingested
(the highest remaining `active` version that was in layer 2), which matches ADR-043 §5's "where
layer 2 goes back to" — and since the numbers are reassigned, no history remains in which "the
version whose snapshot resolves highest" and "the highest version number" disagree.

With this, whether full replace, keyed, or after compaction, no bytes originating from the purged
version remain in layer 2. The column statistics in DuckLake's metadata tables (per-file min/max —
for a name column, the values themselves) go away with the catalog.

**The semantics do not change.** A row written by the purged version remains if it is still current
in a later version — it is re-ingested from the later version's file. That is current data and must
not be erased (ADR-043 open issue 7).

**A rebuild is a re-interpretation.** If the interpretation rules (type inference, JSON flattening,
etc.) changed since the version was created, the post-rebuild diff reflects today's rules. Layer 2
is a derived index, so this is accepted. If a version no longer becomes a table under today's rules,
or its frozen key is now invalid, record `lake_ingest_reason` as ordinary ingest does, skip it, and
do not stop the purge.

**Cost.** One purge re-interprets every version of that resource that was in layer 2 (worst case
100 MB × number of versions). A purge is a rare operation a sysadmin performs with a reason, so this
is accepted. The heavy interpretation runs in ADR-059's child process.

**The role of expire / cleanup / `merge_adjacent_files`.** Ingest is 1 version = 1 snapshot, named
by some version row, and there is no stand-down reload any more, so **ordinary operation produces no
snapshots to expire**. The catalog-wide set operation (`reclaimInSession` and
`reclaimUnreferencedSnapshots`) is removed. When `merge_adjacent_files` (decided in spec §11-2.1,
not wired in v0.34.0) is wired, the replaced old files still need deleting with `cleanup_old_files`.
As today, purge completion does not depend on any of these.

**Package / organisation purges** reduce to prefix deletion. Deleting `lake/<resourceId>/` replaces
`dropResourceTables` and the reclaim, and the ordering constraints outside the catalog (delete rows,
then drop; re-queue stranded tables) are covered by the idempotence of prefix deletion. Whether to
keep the `drop-lake-tables` job or fold `lake/` into the prefix deletion of `purgePackageStorage`
(`resources/`, `previews/`) is decided during implementation.

### 5. The guarantee

Withdraw ADR-043 §5's "layer 2 does not guarantee erasure of bytes", and write instead:

> No path from the application, and deleted from layers 1, 2 and 3 and the search index.
> The following disappear as retention periods pass: S3 noncurrent versions (ADR-037, 30 days;
> MinIO depends on configuration), previews made by intermediate versions and parked for reclaim
> (spec §9.8, 1 hour plus the sweep interval), tombstones inside OpenSearch segments (until merge),
> PostgreSQL dead tuples (until VACUUM), DB snapshots and AWS Backup (retention period).

Whether to bring back the term "legal deletion" depends on how much of this residue, and of the
human-written summaries a purge keeps (open issue 3), the guarantee covers (open issue 2).

### 6. Migration

Layer 2 can be rebuilt, so migration amounts to **running decision 4's rebuild (with nothing to
purge) on every resource that has layer 2**. The targets are "resources with a version whose
`ducklake_snapshot_id` is non-null", countable in advance with the same condition as
`lakeResourceIds` in `listPurgeTargets`, which the package purge uses. Add one job that rebuilds
each resource under the claim (`job`).

Version numbers, hashes and `lake_key_columns` are in `resource_version`; only
`ducklake_snapshot_id` is reassigned. Versions with `state = purged` drop out of the targets
naturally, so **the migration itself erases what past purges left in layer 2**.

- No dual-write period. Switch by setting, run the rebuild, and after confirmation drop the old
  `ducklake` schema (outside Drizzle) and the old catalog's data files. The old files sit directly
  under `lake/` in DuckLake's default layout (schema name / table name hierarchy; checked by the
  spike, decision 7-6) and do not overlap the new `lake/<resourceId>/` layout, so the migration
  procedure deletes them explicitly. They are not made a target of `sweep-lake-orphans`
- During the rebuild, the diff screen shows the existing `DiffUnavailableReason`
  (`'no-previous-version'` / `'not-ingested'` / `'purged'` / `LakeIngestReason`). Whether that is
  enough is open issue 1
- Rolling back is just reverting the setting (keep the old catalog until confirmed)
- If it goes in before the first production adoption goes public, no production history is ever
  migrated

### 7. What the spike checks

Run through `spike/adr-067/` before implementing. The setup is a local SQLite catalog with
`DATA_PATH` on MinIO (the one in `compose.yml`).

1. Whether the equivalents of `ingestParquetVersion`'s full replace, keyed `MERGE INTO`, diffs by
   `AT (VERSION => n)`, `ducklake_expire_snapshots(versions => [...])`,
   `ducklake_cleanup_old_files` and `ducklake_merge_adjacent_files` give the same results as with a
   DuckDB-file catalog. The official docs state no SQLite-specific restriction (the only stated
   difference is how inlining handles types). `MERGE INTO` "only supports a single UPDATE/DELETE
   action currently" (<https://ducklake.select/docs/stable/duckdb/usage/upserting>); today's keyed
   ingest splits upsert and delete into two statements, so this should not bite
2. Whether `set_option('data_inlining_row_limit', 0)` stays in the SQLite catalog and still applies
   after DETACH → re-ATTACH
3. That no `-wal` / `-journal` remains next to the file after DETACH, and that the main file of an
   attempt killed during ingest is consistent
4. Catalog file size (with 50 versions and 500 files) and ATTACH time, side by side with a
   DuckDB-file catalog (re-judging option D)
5. That the `sqlite` extension loads from a pinned `DUCKDB_EXTENSION_DIRECTORY` (matching the
   DuckDB version)
6. That `ducklake_delete_orphaned_files` does not touch anything outside `DATA_PATH` (the catalog
   file); and the hierarchy today's single catalog writes under `lake/` (the range the migration
   deletes)
7. Rebuild time (re-ingesting 50 versions of a CSV in version order)

#### Measurements (2026-10-12)

DuckDB 1.5.5 (DuckLake `d8a1881e`), MinIO in the development environment. The table is 10,000 rows
keyed by `id`, changing 20 rows and removing one per version (`spike/adr-067/README.md`). The same
procedure was run against a DuckDB-file catalog for comparison. Raw results are not committed.

| #   | What was checked                                                                        | SQLite                                                                                                                                                                  | DuckDB file                                     |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Full replace, keyed MERGE, `AT (VERSION => n)`, expire, cleanup, `merge_adjacent_files` | All work. 39 rows in the diff, 14 files cleaned up, 4 objects left                                                                                                      | Same values                                     |
| 2   | Persistence of `data_inlining_row_limit = 0`                                            | Still `0` after re-ATTACH (scope `GLOBAL`). A one-row INSERT writes a file                                                                                              | Same                                            |
| 3   | What remains after DETACH, and SIGKILL during a commit                                  | Only the main file after DETACH. Of 5 SIGKILLs, 3 left a `-journal`, but `PRAGMA integrity_check` was `ok` all 5 times and the latest snapshot matched the commits made | —                                               |
| 4   | Size and ATTACH at 50 versions (97 files)                                               | **188 KB**, ATTACH 4–5 ms, ingest 16.1 s                                                                                                                                | 4.5 MB, 3–5 ms, 9.5 s                           |
| 5   | Pinned extension distribution                                                           | `httpfs`, `aws`, `sqlite_scanner` and `ducklake` all loaded from the given directory with autoloading off                                                               | —                                               |
| 6   | Reach of `delete_orphaned_files`, and the layout                                        | Deletes nothing outside `DATA_PATH` (does delete orphans inside). Layout is `<DATA_PATH>/main/<table>/ducklake-<uuid>.parquet`                                          | Same                                            |
| 7   | Rebuild (49 versions, one left out)                                                     | 17.0 s                                                                                                                                                                  | 9.1 s                                           |
| 8   | Large diffs (100,000 rows × 20 versions, 0.2% / 10% / 100% of rows changed)             | Ingest 320 / 321 / 393 ms per version, diff read 60 / 61 / 56 ms, catalog 147 KB                                                                                        | 148 / 188 / 246 ms, 61 / 56 / 58 ms, 4.2–4.5 MB |

What this shows:

- **No SQLite-specific restriction was found.** Items 1, 2 and 6 give the same values as a
  DuckDB-file catalog
- **Item 3 needs the rule in decision 2.** The main file is consistent, but only with the
  `-journal` next to it. Discard the file of an attempt that died and download afresh from S3
- **By the same rule as item 6, today's single catalog (`DATA_PATH` is `lake/`) keeps its files under
  `lake/main/<table>/`.** The migration (decision 6) deletes `lake/main/`, which does not overlap the
  new `lake/<resourceId>/`
- **From item 7, a purge's rebuild takes a dozen-odd seconds for 50 versions of one resource**, on a
  10,000-row table, growing with the size of the versions
- **From item 8, large diffs do not widen the gap between SQLite and a DuckDB file.** Diff reads are
  the same at every change rate; their cost is set by the Parquet at both ends (the table's size).
  The write gap does not grow with the amount changed; it is a roughly constant overhead per commit
  (about 150 ms). The catalog is about 1/30 the size whatever the change rate

## Consequences

- **Changes** (counted at v0.34.0):
  - `packages/lake` (1,845 lines excluding tests). Mainly `connection.ts` (356 lines: ATTACH,
    extensions, inlining, pool settings), `config.ts` (220 lines: schema name, connection string),
    `table.ts` (124 lines), `maintenance.ts` (83 lines: the expire set operation goes).
    `ingest.ts` / `keyed-load.ts` / `diff.ts` barely change; `restandLakeTable` goes
  - `lake-ingest.ts` / `lake-reclaim.ts` (371 + 179 = 550 lines). `lakeStandDown` and
    `reclaimInSession` go; fetching, PUTting and moving the catalog pointer come in
  - `purgeFromLake` in `resource-version-service.ts`, and the layer 2 migration / backfill paths
  - `organization-service.ts`, `package-service.ts` (package / draft purge), `routes/admin.ts`
    (drop `DROP SCHEMA` from delete-all)
  - The worker's `build-context.ts` (429 lines: layer 2 wiring), `steps/lake.ts` (62 lines),
    `retry-lake-ingest.ts`, `sweep-lake-orphans.ts` (48 lines), `index.ts` (catalog connections)
  - `lake-scan.ts` (113 lines) loses the connection constant and the key-check branch.
    `version-diff-service.ts` (158 lines) barely changes
  - `packages/shared/src/lake-limits.ts`, the connection budget in `infra/lib/config.ts`, the
    extensions in the `Dockerfile`
  - OData, the sandbox and Interpret only borrow `@kukan/lake`'s DuckDB helpers and are not touched
- **Tests**: the four `*.ducklake.test.ts` files already use a file catalog, so they are expected to
  work with the ATTACH string changed. The "another table holds it so it does not disappear" pin in
  `purge.ducklake.test.ts` is removed and replaced with "after a purge, no file of the purged version
  is in the catalog or the generation". The connection formula in `synth-multi-site.test.ts` changes
- **Documentation**: revise ADR-043 §5, §6-4 and open issues 3 and 7; `phase-versioning-2-ducklake.md`
  §9 and §11-3; version purge and `drop-lake-tables` in `docs/pipeline.md` / `docs/jobs.md`; the
  `ducklake` schema and its deletion procedure in the system administrator guide (ja/en); connection
  counts in the multi-site guide
- **DB**: the only Drizzle migration is adding `resource_pipeline.lake_catalog_key` (additive, so the
  previous image still works). Dropping the `ducklake` schema is a procedure outside Drizzle
- **Operations**: each diff fetches one catalog file (188 KB at 50 versions, cacheable by key). The libpq share
  (web +1 / worker +2) leaves the PostgreSQL connection budget. Multi-site separation comes for free
  (ADR-043 open issue 3). A release that raises the DuckLake catalog version runs the rebuild
- **Effort estimate**: switching the catalog itself is about a week. The heavy parts are the
  rebuild-based purge and the catalog file's write-ahead recording and pointer move. 2–4
  person-weeks including tests and docs

## Open Issues

1. **How to show diffs during a rebuild.** Add "rebuilding" to `DiffUnavailableReason`, or are the
   existing reasons enough
2. **Settling the guarantee** (decision 5). Whether to delete S3 noncurrent versions explicitly at
   purge time (together with ADR-043 open issue 8), or write the 30-day residue into the guarantee
3. ~~**Propagation to derivatives.**~~ **Resolved (2026-10-12).** When this was drafted, the
   purge itself touched neither the AI summary (ADR-053) nor the resource embedding (ADR-054), so a
   purge that emptied the resource, or one where Summarize does not regenerate (private package, no
   provider), left a summary made from the purged content in `resource.summary`, the search document
   and the embedding. The purge now removes **the AI summary made from that version** (judged by the
   summary's version, whether or not it is live) and queues the search-document and embedding sync.
   Changing a summary's visibility is now a conditional update on the row it read, so it cannot write
   back text the purge removed.

   **A human-written summary (`source: 'human'`) is kept on purpose.** It is an editor's text, and a
   machine cannot tell whether it quotes the purged content. How the guarantee (decision 5) states
   this is decided in open issue 2

4. **The doubled derivation of S3 connection settings** (ADR-043 open issue 11) is not solved here
5. **Cross-resource queries** are out of scope. If done, through registering multiple preview
   Parquet files (ADR-032 open issue 3), independent of how layer 2 is split
6. **The procedure when the DuckLake catalog version goes up.** Running the rebuild is the default
   (decision 1), but the time for rebuilding everything and how diffs look meanwhile (open issue 1)
   weigh with the count. Lazy migration — opening with `AUTOMATIC_MIGRATION` and writing to a new key
   — is also possible, but rolling back to the previous image then cannot read migrated catalogs.
   Decide when the catalog version first goes up
7. **Removing the global lock `LAKE_INGEST_LOCK`** (decision 2). Confirm during implementation that
   the lock guards nothing besides layer 2

## Related

- ADR-043: Resource versioning and row-level diff — revises §5 and §6-4, closes open issue 3, and
  overturns the settlement of open issue 7
- ADR-044: Per-resource execution claim — the basis for one writer per resource
- ADR-045: Write-ahead recording of storage objects — the catalog file's PUT goes through it
- ADR-046: Settling the original and separating its interpretation — the unit of re-ingest
  (`withInterpretedVersion`)
- ADR-028: Async organisation purge with a durable claim — the pattern of the version purge's state
  transitions
- ADR-037: Backup strategy — the basis for the residue periods in the guarantee
- ADR-041: Multi-site deployment — closes the open issue on splitting the catalog
- ADR-053 / ADR-054: AI summary and resource embedding — purge propagation (open issue 3, resolved)
- ADR-057: Plain-table XLSX — would widen layer 2's targets if implemented
- ADR-059: Running the worker's heavy work in a child process — where the rebuild's interpretation
  runs
- ADR-005: Only four adapters — the extensions are swapped one for one, and no adapter is added
