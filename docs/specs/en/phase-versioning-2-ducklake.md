> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase-versioning-2-ducklake.md`](../jp/phase-versioning-2-ducklake.md).

# Phase Versioning-ii: Row-Level Diffs via DuckLake (layer 2) — Implementation Spec

> **ii-a implementation complete (2026-07-27). ii-b implementation complete (2026-08-22). ii-c onwards has not been started.**
>
> **§1–§5, §7 (except §7.2), §10, §12 and §13 are a record.** After implementation, ADR-046
> changed the ordering and who does the interpreting (`Fetch → Version → Interpret → Lake → Index`,
> with type inference in DuckDB). For the current shape see `docs/pipeline.md`. The file paths and
> step names below are the ones in use at the time.
>
> **§6, §7.2, §8, §9, §11 and §14 are design notes written before starting.** They reflect what was
> learned from implementing and operating ii-a, and ii-b can start from here.

> **Goal**: Ingest tabular resources (CSV/TSV) as DuckLake tables and provide **row-level diffs,
> time travel and column schema history** between versions. The catalog is the existing PostgreSQL
> and the data files are the existing storage (S3/MinIO). It is positioned as a derived index that
> can always be rebuilt from the canonical versions of Phase i (layer 1). ADR-043 is authoritative
> for the design decisions.

## 0. Decisions for ii-b

**This table is the conclusion. The reasoning, the history and the measurements are in the body of
each section, and you can implement without reading them.** Sections titled "shapes considered and
not taken (history)" (§9.7 / §11-7) and blocks headed "evidence (measured)" are not decisions.

| Decision                                                                                                                                               | Where   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **Changing the primary key creates a version** (it is part of the interpretation; ADR-046 decision 3)                                                  | §6.4    |
| Key columns must not contain NULL. A version that breaks this is not ingested, nor demoted to keyless                                                  | §6.4    |
| The key columns used are **frozen when the version is created** (written by the Version step, not at Lake time)                                        | §6.4    |
| The reason it was not ingested is recorded in **`lake_ingest_reason`** (written once)                                                                  | §6.6    |
| There are three such reasons: **`key-missing`** / `key-null` / `key-not-unique`                                                                        | §6.6    |
| Keyed ingest is **two predicated `MERGE` statements in one transaction** (the diff approach)                                                           | §11-2.4 |
| Diffs are produced by **matching the content at both ends on the primary key**. `table_changes` is not used                                            | §7      |
| The first stage applies **only when `lake_key_columns` matches at both ends**. Otherwise it degrades to keyless                                        | §7      |
| A version row's `ducklake_snapshot_id` is **written once**. Moving content is done by issuing a version                                                | §7.2    |
| **`superseded` is abolished.** Layer 1's automatic fallback after a purge is **the highest `active` version**                                          | §7.2    |
| Existing `superseded` rows are **converted** by a backfill; left alone, every predicate carries two regimes                                            | §7.2    |
| A resend decides "already at the destination" **by content**, not by version number                                                                    | §7.2    |
| The revert response keeps `restored` (the destination named); the published version number is added separately                                         | §7.2    |
| Content is moved from a **source reading that version's snapshot**; the method has three branches                                                      | §7.2    |
| The settled layer (primary-key setting) lives in **`resource.column_settings`** (jsonb). No dedicated table                                            | §6.2    |
| Run `merge_adjacent_files` at the end of an ingest. The threshold is the live file count, default **50**                                               | §11-2.1 |
| `rewrite_data_files` is not used                                                                                                                       | §11-2.3 |
| `CHECKPOINT` must not be run against the lake catalog                                                                                                  | §11-2.2 |
| Data inlining is disabled (`data_inlining_row_limit = 0`)                                                                                              | §11-1   |
| `parquet_compression` is set to `zstd`                                                                                                                 | §11-4   |
| expire uses the explicit-list form. `older_than` is not used                                                                                           | §11-3   |
| **A purge claims only "making it unfetchable"; erasing the bytes in layer 2 is not guaranteed**                                                        | §9      |
| Deleting a prefix in the data directory outside DuckLake's management is forbidden                                                                     | §9      |
| Do not use "physically deleted", "completely deleted" or "legal deletion" in the spec, the UI or the audit log ("delete" itself is fine)               | §9.5    |
| Restoration is PG-only. Reconciliation **checks that the files actually exist**                                                                        | §11-5   |
| A table that has become unreadable has its **head rewritten from the highest-recorded healthy layer-2 version** (it is not `DROP`ped)                  | §11-5   |
| **The rollback targets for layer 1 and layer 2 are looked up separately** (layer 2 uses "the version whose recorded snapshot is highest and resolves") | §9.1    |
| Whether layer 2 is stepped down is decided by **whether layer 2 stands on that version**, not by whether it is live                                    | §9.1    |
| The wording of the purge confirmation depends on **whether the target is live**, not on the total number of versions                                   | §9.6    |

## 1. Prerequisites

- **Phase i (layer 1) is complete**: the `resource_version` table, version file retention (all
  formats), purge, migration (assigning v1;
  `docs/specs/en/phase-versioning-1-file-retention.md`)
- **The existing type inference (ADR-029)**: `inferColumnType()` in
  `apps/worker/src/pipeline/type-inference.ts` infers a column as `integer` / `float` / `boolean` /
  `string`, Extract assembles it into a `ResourceSchema` (`packages/shared`), and Phase i
  **snapshots it per version** (`resource_version.schema`)
- **The server-side query sandbox (ADR-032)**: materialize Parquet in memory → the isolation model
  of `enable_external_access=false` + `lock_configuration=true`. **Unchanged in this phase**
- **`@duckdb/node-api`** was introduced in ADR-032. DuckLake is used as an extension of the same
  library
- **No new adapters (ADR-005)**: DuckLake is not turned into an adapter; it is isolated in a
  dedicated package

## 2. Staging (this phase does not implement everything at once)

Most of the value of row-level diffs comes from just "an added/removed summary without a primary
key + schema-change detection". Primary key MERGE and the type-demotion UX are extensions stacked
on top, introduced in the following order.

| Stage                      | Content                                                                                                                             |  Primary key  | Type demotion UX  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | :-----------: | :---------------: |
| **ii-a (MVP)** ✅ complete | DuckLake ingest + keyless diffs (added/removed rows, row counts) + schema-change detection + the diff API + **the diff UI (admin)** |       –       |         –         |
| **ii-b**                   | Primary key specification (resource setting, manual) → tracking **changed rows** via `MERGE`. Column schema history                 |    manual     |   recorded only   |
| **ii-c**                   | UX presenting type-demotion choices, AI suggestions for key candidates and types (an ADR-040 extension)                             | AI candidates | choices presented |

**ii-a goes first as the smallest vertical slice** (confirming on real data that ingest → diff
works). Later stages are stacked based on demand and the results of the spikes.

### 2.1 Terminology: "row-level diff" and "diff summary"

Following the three-stage fallback of ADR-043 (§7), the UI and the documentation distinguish the
following. Confusing them creates the misunderstanding that "ii-a should show changed rows".

| Term                           | Stage      | Content                                                                              | Available in |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------ | ------------ |
| **Diff summary** (just "diff") | no key     | The **number** of added and removed rows plus sample rows. Changes are not counted   | ii-a         |
| **Row-level diff**             | with a key | Rows are identified by the primary key, tracking additions, removals and **changes** | ii-b         |

In the ii-a screens we do not say "row-level diff", only "diff". Because rows are not identified,
no metric equivalent to "N rows changed" is shown either (§7-2).

## 3. Architecture Overview

```
Layer 2 (this spec): DuckLake (tabular resources only, CSV/TSV, from ≤50MB)
  catalog     a dedicated schema in the existing PostgreSQL (e.g. ducklake)  ← managed by the DuckLake extension, outside Drizzle
  data        a dedicated prefix in the existing bucket (e.g. lake/)          ← Parquet bodies, immutable, append-only
  table       res_{resourceId with hyphens removed}                           ← derived mechanically from resource.id
  version map resource_version.ducklake_snapshot_id                           ← "a resource version ↔ a DuckLake snapshot"

  === ingest (Worker, downstream of the Phase i version capture) ===
  Fetch → Extract (type inference, ADR-029) → Version (layer-1 capture, Phase i) → Lake (layer-2 ingest, new) → Index
    The Lake step: commits the new version of a tabular resource to its DuckLake table and
                   records the resulting snapshot ID on resource_version

  === reading diffs (API, new) ===
  GET /resources/:id/versions/:v/diff?from=      ← only fixed queries assembled on the server (touches DuckLake)

  === queries (existing, ADR-032) ===
  POST /resources/:id/query                       ← raw SQL from users/AI. Does not touch DuckLake (unchanged)
```

**DuckLake is a derived index that can be rebuilt from layer 1** (ADR-043). Even if the catalog and
the data are destroyed, it can be restored by re-ingesting every resource. The canonical copy is
the layer-1 version file.

## 4. Step 1 — The DuckLake Integration Foundation (the `@kukan/lake` package)

Code that touches DuckLake is isolated in a single package (the ADR-005 philosophy: nothing but
api=read / worker=write may touch DuckLake).

1. **Connection** (ATTACH from a DuckDB session):

   ```sql
   ATTACH 'ducklake:postgres:host=<pg> dbname=<db>' AS lake (
     DATA_PATH 's3://<bucket>/lake/',
     METADATA_SCHEMA 'ducklake'
   );
   ```

   - The catalog lives in the same PostgreSQL as the semantic layer (one monolith that diffs and
     version mappings can join against). The DuckLake catalog tables are **outside Drizzle's
     migrations**
   - The ATTACH connection string is in **libpq keyword form** (`host=… dbname=…`), not a URL
   - Storage connection: the same credentials and endpoint as S3StorageAdapter are fed into
     DuckDB's S3 secret. **MinIO requires `URL_STYLE 'path'` + `USE_SSL false` +
     `ENDPOINT host:port`** (decompose the `S3_ENDPOINT` URL into host:port and whether SSL is
     used). For AWS S3 the endpoint is omitted
   - The `httpfs` / `postgres` / `ducklake` extensions are loaded with `INSTALL` + `LOAD`
     (the spike confirmed this succeeds even in offline environments)

2. **Table naming**: `res_{resourceId with hyphens removed}`. It can be derived mechanically from
   `resource.id` and the reverse mapping is unique. Human-readable names are not brought into
   DuckLake (so renaming a resource does not ripple into the physical layer)
3. **Writes are serialized across the whole catalog**: take
   `pg_advisory_xact_lock(LAKE_INGEST_LOCK_KEY)` and do "acquire the lock → the DuckLake
   transaction → update the semantic layer (`resource_version`) → commit" inside one job handler.
   **One version update = one DuckLake transaction** (no commits spanning several tables → keeping
   the version↔snapshot mapping simple).

   It is catalog-wide rather than per-resource because **snapshot IDs are a catalog-wide sequence**
   and we identify the snapshot we committed by "the maximum value on re-read". Two concurrent
   ingests could observe each other's IDs. Ingest only runs when a resource's content changes, so
   the throughput cost of serialization is worth the certainty of identification. Once the ID can
   be obtained as an attribute per table, the lock becomes unnecessary (room for future
   improvement)

4. **Consistency after a failure**: reconciliation looks **both ways**.

   - **A snapshot with no corresponding row in the semantic layer** (a crash in the instant between
     the DuckLake commit and the semantic-layer update) is "unsettled". Record it in the audit log
     and leave it (an unreferenced snapshot is harmless and is naturally reclaimed by the expire
     described later), or expire it
   - **A snapshot a version row names but that does not resolve** has its `ducklake_snapshot_id`
     nulled, degrading to the three-stage fallback of §7. **Not resolving** has two forms — the
     snapshot is not in the catalog (already expired), or **it is in the catalog but the files are
     gone** (after cleanup / orphan sweeping / a lifecycle rule removed them). **The latter requires
     checking that the files actually exist**
   - **Check that the table's current content can be read, by reading a column.** Nulling a version
     row only detaches the semantic-layer pointer; it does not repair a table that is holding a
     missing file. **`count(*)` cannot decide this** (it is answered from catalog statistics and so
     passes). And **the current head is sometimes not named by any version row**, so checking every
     version row will not find a broken head — **this check is performed against the table, not
     against versions**. There are two ways to fix an unreadable table, and which one applies
     depends on **whether there is a healthy layer-2 version at all** (§11-5; not the live version)

   Why the last two are needed, with measurements, is in §11-5.

## 5. Step 2 — The Lake Ingest Step (Worker)

Add `apps/worker/src/pipeline/steps/lake.ts` and insert it **after the Version step** in
`processResource` (layer 2 comes once the layer-1 version is settled).

- **Targets**: tabular formats (CSV/TSV, ≤50MB — the same set that Parquet generation targets
  today). Everything else is skipped.
- **Input**: it only runs when the Version step captured a new version (vN) this time round. The
  type inference result from Extract (`ResourceSchema`) is used as the column types.
- **Ingest logic** (deepened per stage):
  - **ii-a**: **insert all rows into the table** per version (no primary key = full replacement).
    Thanks to DuckLake's copy-on-write, unchanged files are shared between versions and the write
    costs only the difference.
  - **ii-b**: when a primary key is specified, apply row by row with `MERGE` (§7 below).
- **Recording the snapshot**: write the `snapshot_id` obtained from the commit into
  `resource_version.ducklake_snapshot_id`. From then on "reading version vN" is
  `SELECT ... FROM lake.res_x AT (VERSION => snapshot_id)`.
- **Non-critical**: a failure of the Lake step is recorded on the step but the pipeline as a whole
  continues (layer-1 versions, previews and search still work). Layer 2 can catch up later with a
  re-ingest.

### 5.1 DB schema addition (`resource_version`)

Columns are added to Phase i's `resource_version` (a Drizzle migration):

- `ducklake_snapshot_id BIGINT` (non-null only for tabular versions; the layer-2 pointer of the
  version)
- (ii-b) the primary key is held as **the current value on the resource side and the value used on
  the version side** (`lake_key_columns`) (§6.1).

  > This originally said "not needed on the version side". **§6.1 overturns that** — since the
  > semantics of a diff differ per version, only the version side can record which key each version
  > was ingested with.

### 5.1.1 Concurrent runs for the same resource

`resource_pipeline` is started per SQS message and there is no mechanism serializing the whole
pipeline per resource. Duplicate messages or successive updates can make two runs overlap.

**Give each run its own write destination**: the key of the resource body is run-specific
(`resources/{packageId}/{resourceId}.{writeToken}`) and `resource.storage_key` becomes the pointer
to the current content. The pointer, `hash` and `size` are moved **in a single statement**, and the
move is conditional on "the pointer still holding the value read at the start of the run". This way
the row describes the object it points at no matter which run finishes in which order. A run whose
condition was not met knows its bytes are no longer the content, so it does not perform the
remaining steps.

Replaced objects are not deleted but recorded in `orphaned_object`, and a sweep removes them after
the retention period (the same mechanism as for previews).

**Settling a version is serialized**: "decide the version number → copy to the version file →
insert the version row" is done **in a single transaction** under
`pg_advisory_xact_lock(hashtextextended('resource_version:' || resourceId, 0))`
(`PipelineContext.createVersion`). Without this, two runs would choose the same vN and the unique
constraint would leave only one of the rows.

Queries while holding the lock **must go through that transaction's connection**. Requesting
another connection from the pool while holding the lock deadlocks once the number held reaches the
pool limit (the worker's pool limit is 3). Migration takes the same lock and re-confirms inside it
that the pointer has not moved before copying.

**The hash of an upload is computed by the worker**: `upload-complete` records only the size and
leaves the hash null. The version change gate and the version row's hash depend on it, so Fetch
always computes it from the actual bytes (otherwise a client could choose "never let a version be
created again").

Hash verification after the copy is no longer needed. The copy source is a run-specific key that
nobody rewrites, so the bytes Extract read, the hash Fetch measured and the bytes the version holds
are identical. Matching `sourceHash` is not needed to settle a version either (it is only used to
decide which content a preview depicts; §5.2).

### 5.2 Ingesting existing data (bundled into the one-time migration)

Layer 2 takes effect from newly ingested versions, so as-is existing resources would never be
diffable. This is solved by bundling the layer-2 ingest into Phase i's one-time migration (the
admin screen path):

1. **Layer 1**: copy the current file of a resource that has no versions as v1 and create the
   version row (existing behavior)
2. **Layer 2**: ingest **the current version** of tabular resources into DuckLake and record the
   snapshot (new)

**Why only the current version**: the preview Parquet is not stored per version — it always holds
the content of the newest version. Past versions therefore cannot be ingested retroactively. Only
the current version can be ingested, and diffs are produced from between that version and the next.

Preview keys are made unique per pipeline run
(`previews/{packageId}/{resourceId}.{writeToken}.parquet`). Readers follow the pointer in
`resource_pipeline.preview_key`, so an object that has been resolved once is never rewritten by a
later run. Replaced keys are recorded in the `orphaned_object` table and an **hourly sweep job**
deletes those past the retention period (one hour by default) — so as not to cut off a request that
resolved the old key just before the pointer was updated. The live body key is reclaimed by the
same table and the same sweep (ADR-043, making the resource body key run-specific).

**Deciding which version it may be attached to**: alongside the preview it generates, Extract
records the hash of the bytes it was made from in `metadata.sourceHash`. The migration ingests only
when this matches the version's hash. The version's hash or the success of the Extract step is not
enough, because the migration _creates_ the version from the current file, so the two hashes are
guaranteed to match (after a file is replaced, the old preview is still there while the pipeline is
queued).

**Previews created before this was introduced have no `sourceHash`, and those are exactly what the
migration targets**, so it falls back to the following weaker condition: the pipeline is `complete`
(it has not been re-queued behind a new file) and the version is the resource's current content.
The window the recorded hash closes — "already replaced, pipeline not yet run" — is excluded by that
`status` condition.

The ingest runs serially in one session and the advisory lock is taken per resource (holding the
lock throughout the migration would block the pipeline's own ingests). One failure does not take
the others down with it.

The migration card in the admin screen shows **both** remaining counts, layer 1 (no version) and
layer 2 (not ingested), and disappears once both reach zero.

## 6. Step 3 — The Settled Schema Layer and Primary Key Specification (ii-b)

### 6.1 Separating the inferred schema from the settled schema

Every column schema KUKAN holds today is **inferred** (a product of the ADR-029 type inference),
and there is no path for a human to settle or override it:

| Layer                             | Stored in                                                                                          | Written by                  | Overwrite rule                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| **Inferred** (system)             | `resource_pipeline.metadata -> 'schema'` (latest) / `resource_version.schema` (frozen per version) | worker (Extract, Version)   | Recomputed and overwritten on every rerun        |
| **Settled** (human) ★ new in ii-b | `resource.column_settings` (what a human settled about the columns, §6.2)                          | administrators (via the UI) | A human decision. The pipeline does not touch it |

**A primary key is not a product of inference but schema information settled by a human**, and the
settled type an administrator chooses in ii-c has the same nature. Putting both in the same settled
layer satisfies two things at once: (a) recomputing the inference does not destroy human decisions,
and (b) the primary key and the settled type do not end up scattered in different places.

#### The settled layer is a pair of "the setting" and "the rule that was used"

**If the setting is held only as a current value, nobody can answer how past versions were
ingested.** This repository has already reached that answer twice: `format` and `schema` are both
pairs where "the resource holds the current rule and a version holds the rule as of when it was
created" (see the comment on `resource_version.format`, ADR-046 §6 — a resource's label is
editable, so interpreting settled bytes with the current label means **reading them with a rule
that was never applied**).

|                        | Where                                                       | What                                                         |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| The setting (current)  | `resource.column_settings` (jsonb, §6.2)                    | The primary key and settled types to apply to later versions |
| The rule that was used | `resource_version.lake_key_columns` (jsonb, null = keyless) | The key columns **frozen when the version was created**      |
| The interpretation     | `resource_version.schema` (existing)                        | Frozen per version                                           |

**There are three reasons the version side is needed.** (a) A diff can only produce changed rows
when both ends were ingested with the same key, so if the key specification changes in between the
semantics switch at that boundary. (b) Since diff semantics differ per version, only the version
side can record how each version was ingested (one resource being keyless for v1–v5 and keyed from
v6 is perfectly ordinary). (c) The history of key-specification changes itself.

**Settled types do not need to be added to the version side.** Once a settled type becomes the
an input to version identity (§6.5, the fourth after ii-b's key), changing it stands up a new
version and that version's
`resource_version.schema` is frozen as the interpretation result including the settled type. Only
the primary key needs its own record, because `schema` carries no declaration of a primary key
(`ResourceColumn.unique` is a computed value for "can this be offered as a candidate", not whether
a human specified it).

### 6.2 Where the setting lives

Per column, it holds only the information a human has settled (inferred values are not duplicated —
inference is read from the inferred layer above):

- Identifying the column (`name`)
- Whether it is part of the primary key (multiple columns allowed)
- The settled type (ii-c; falls back to the inference when unset)
- Future: a home for column metadata given by humans — descriptions, aliases, sensitivity flags and
  so on

**It goes in `resource.column_settings` (jsonb). No dedicated table.** By the "settle operations are
batched into one version" constraint below, writes are batched from the start, and reading the
primary key means reading the whole set of columns at ingest time. Nothing is read or written
independently per column, so there is no one in ii-b to pay for what a table buys (per-column unique
constraints, cross-cutting queries). Move it when settled types, descriptions and sensitivity flags
have grown in ii-c and columns actually need to be queried across resources — that migration will
rest on column metadata having grown, rather than on the expectation that it will.

**The name `resource_column` is not used.** `ResourceColumn` in `packages/shared` is already the
type of an **inferred** column (an element of the jsonb in `resource_version.schema`), and side by
side the type reads as a row of that table. The name would merge exactly the inferred and settled
layers that §6.1 is trying to separate.

Candidates and where the thinking stands:

| Option                                               | Assessment                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A dedicated jsonb column on `resource`** (adopted) | Enough if it is 1:1, read whole and written whole. Only humans write it so nothing mixes in (there is precedent in `pending_metadata` etc.)                                                       |
| A dedicated table                                    | The per-column unique constraint can be enforced in the DB and cross-cutting queries are natural. **A bet on the column metadata of ii-c and beyond**; nothing in ii-b's requirements pays for it |
| ~~`resource_pipeline.metadata`~~                     | **There is no row until the pipeline has run**, so it cannot be set. Putting human decisions in an area the worker merges into with `\|\|` risks destroying them when the products are recomputed |
| ~~`resource.extras`~~                                | Mixes with the cron health-check operational values and cannot have per-column granularity                                                                                                        |

**The deciding factor is "will it be read and written independently per column".**

#### The shape

```
resource.column_settings   jsonb NOT NULL DEFAULT '{}'::jsonb
  { "primaryKey": ["order_no", "line_no"] }        <- the only key ii-b reads
  { "primaryKey": [...], "types": { ... } }         <- what ii-c adds to the same object

resource_version.lake_key_columns   jsonb NULL     <- frozen when the version is created; null = keyless
  ["order_no", "line_no"]
```

**An object, not an array.** ii-c's settled types sit beside `primaryKey`, so it grows without a
second column. A top-level array (a list of per-column settings) would build nesting ii-b does not
need in order to reach the same place.

**The empty array is never written.** "No key set" and "an empty key" mean the same thing, so there
is one way to say it: `[]` is normalized to the key's absence on write, and readers only ask whether
`primaryKey` is there. Two spellings would add a keyless branch to every reader.

**Validation happens when the key is set** (the top row of §6.4's table):

| Rule                                        | When broken                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Names exist in the current version's schema | Error. A name that does not simply becomes `key-missing` at ingest time  |
| No duplicates                               | Error. The `ON` predicate would compare one column twice, saying nothing |
| No empty strings                            | Error                                                                    |
| Order is kept as given                      | — (composite keys display and freeze in a stable order)                  |

**Only humans write `column_settings`.** The pipeline does not (§6.1), so it never contends with the
worker's `||` merges — the same reason `resource_pipeline.metadata` was ruled out.

### 6.3 Impact on the display paths once settled types are introduced (an ii-c question)

Column type display today is **entirely inference-based**, and bringing in a settled layer requires
a "prefer the settled type if there is one" decision on all three paths below:

| Path                                                             | Actual source                                | Origin                                      |
| ---------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| The column list on the resource detail page (`useParquetSchema`) | A range read of the preview Parquet's footer | **Parquet baked with the inference result** |
| `GET /:id/schema` (also MCP `get_resource_schema`)               | `resource_pipeline.metadata -> 'schema'`     | The inferred schema                         |
| The column schema in the version history                         | `resource_version.schema`                    | Inference frozen per version                |

In particular, **the preview Parquet is materialized with inferred types**, so when a settled type
contradicts the inference we must decide between "re-bake the Parquet (re-Extract)" and "override
only the display layer with the settled type". This is decided when ii-c starts (it does not arise
in ii-a/ii-b, which have no settled types).

### 6.4 Handling the primary key

- **An administrator specifies the primary key columns freely in the UI** (multiple columns
  allowed). When specified, the Lake ingest switches to the `MERGE` path. **ii-b is manual
  specification only.**
- **Changing the primary key creates a version.** A version is "these bytes, read this way"
  (ADR-046 decision 3), and the key is part of the reading. The bytes do not move, so the new
  version **owns a copy of the same content** (the ADR-043 §3 rule applies as-is — an object that is
  already owned is copied).
- The boundary is therefore **the version itself**. The "later" in "applies to later versions"
  starts with that version, and the diff semantics of past versions do not change retroactively.
- Computing candidates is already done. The ADR-046 interpretation produces `distinctCount` and
  `unique` per column (all rows non-null and distinct) and freezes them into
  `resource_version.schema`, so the picker needs no new computation to offer candidates.
  **This only goes as far as single-column keys**, though (see "composite keys" below).

> **This originally said "specifying a primary key does not itself create a version".** Two
> authoritative sources (ADR-046 decision 3 and the note in ADR-043 §1-4) both say the opposite, and
> **even the UI section within this same §6 (§6.5) said "select several columns together and make
> one version per application"** — the isolated statement was that one sentence.

#### Freezing happens when the version is created

**`lake_key_columns` is written by the Version step, not the Lake step.** It copies the setting on
the resource side exactly as it was at the moment the version row was created, and Lake **reads it
from the version row**. It does not look at the current value on the resource side.

**There are three ways a version is born.** That one rule covers the first two: content arriving
(the key is the setting at that moment) and the key specification changing (the key is the new
setting). **The third is a revert issuing one, and there the rule points the other way.**

#### The version a revert issues copies the destination's key

**Not the resource's current setting.** A revert "issues that version's content again" (§7.2), and a
version is "those bytes, read this way". If the destination was read under an older key A, so is the
version issued for it — freezing the current setting B produces a version whose **bytes came back
and whose reading did not**.

**`resource.column_settings.primaryKey` goes back to the destination's value in the same transaction
as the pointer move.** This is what `format` already does (ADR-046 §6 — left behind, the resource
describes recovered content by a rule never applied to it); without it the resource's current
setting and the live version's interpretation disagree, and the next fetch records that disagreement
as a new version.

**Without it, versions grow without bound.** Settled compares the key too (§7.2 decision 5), so a
version that froze B never matches destination A and **every resend issues another version**. Half
of the change is no better than none, so these two land together:

| What lands                                      | What happens if only that half does                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| The key joins settled's comparison              | Every resend issues another version (the issued one freezes the current setting)   |
| The issued version copies the destination's key | A destination differing only in its key cannot be restored (old settled passes it) |

**The current value must not be read at Lake time.** Version and Lake are asynchronous, and a
failed ingest is retried later by the sweep (§14.1). A key change creates a version, so **if the key
changes again before that version is ingested, yet another version stands up** — reading the current
value would ingest an already-created version with a key from a different generation than its
number. With the key frozen on the version, it is ingested with the same key no matter how many
hours later the sweep runs.

**This is the same shape as an answer this repository has already given twice.**
`resource_version.format` is frozen on the version side for the reason that "a resource's label is
editable, so interpreting settled bytes with the current label means **reading them with a rule that
was never applied**" (ADR-046 §6), and `schema` is the same.

#### What happens when a key-change version reaches layer 2

**If the immediately preceding version is in layer 2, nothing moves.** That version's bytes are the
same as the preceding one, so even with the new key `MERGE` finds every value predicate false and
the delete side does not match either. **One snapshot is consumed and not a single row is written.**
That snapshot becomes the record of the boundary: "the key scheme changed from here".

**If it is not in layer 2, it writes normally — and that is the ordinary path for fixing a key.** If
the preceding version was rejected with `key-missing` / `key-not-unique`, the current content of
layer 2 is **an older version**. Putting the same bytes on it with the new key makes `MERGE` write
the real difference against the current content — the amount written is "how much the content moved
during the stretch where the key was broken", not the cost of the key change itself. **Do not assume
"a key-change version always writes zero".**

**If the new key is not unique for that content, that version does not enter layer 2**
(`key-not-unique`, §6.6). The version itself still exists (it is in layer 1 and downloadable), so
all that is lost is the row-level diff with that version as an endpoint. **Whether the key
specification is valid is shown on a confirmation screen before it is applied** — rejecting after
creating a version is indistinguishable, from the operator's point of view, from "I applied it and
it did nothing".

#### Key columns must not contain NULL

`MERGE`'s `ON` uses `=`, and `NULL = NULL` does not hold. A row with a NULL **never matches** an
existing row and is re-inserted for every version. Inside the table the key stops being a key, and
in later versions one source row matches several target rows and both get updated, so **the
row-level diff is wrong from then on** (measured: `merge.ducklake.test.ts`).

`IS NOT DISTINCT FROM` would match NULLs to each other, but we do not use it. "Two unknowns are the
same row" is a claim about the data, and it is exactly the "fabricated change history based on
guessing" that ADR-043 rejected. If the publisher intends "NULL is one value", they should express
it with a sentinel value.

The basis for the check is `nullable` / `nullCount` in `resource_version.schema`, so **no extra
computation is needed**.

#### Composite keys

- `MERGE` accepts composite keys (`ON t.a = s.a AND t.b = s.b`; measured)
- **Not allowed if any component is `nullable`.** This is independent of the uniqueness of the
  combination, and neither implies the other (two individually non-unique columns being unique in
  combination is the textbook composite key)
- **The frozen schema cannot answer whether the combination is unique.** All it holds is a per-column
  `distinctCount`. Composite keys must be validated against the real data
- `count(DISTINCT a, b)` produces a **binder error**. Use `count(DISTINCT (a, b))` or
  `SELECT count(*) FROM (SELECT DISTINCT a, b …)`

#### Where validation happens, and what happens when it fails

|                        | When it is decided                      | What happens on failure                                                                              |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **When setting a key** | The schema of the current version       | **Error. Do not allow the setting.** It is synchronous, a human is there, and no content is at stake |
| **At ingest time**     | That version's schema and the real data | **Do not ingest that version into layer 2, and record the reason**                                   |

**The version itself is not rejected.** A NULL in a key column is a property of the publisher's
data, not a system error. The content is valid; all that fails is the row correspondence. Rejecting
the version would leave the resource serving old content while the publisher believes they updated
it, which is worse than not getting a diff. A key specification is an aid to interpretation, not a
contract with the data.

**It is not demoted to keyless.** Mixing one full-replacement version into a keyed history makes
that version's diff render as every row deleted and inserted. In reality one row simply had an empty
key, yet we would be **presenting a fabricated history as fact**: "every row changed". Not ingesting
is more honest.

- **ii-c**: add "primary key candidate suggestions" to the AI suggestion foundation of ADR-040
  (deterministically compute each column's uniqueness and null rate → present candidates, without
  asserting). A human always makes the final call.

### 6.5 A settled type becomes the fourth input to the version gate (ii-c, read before starting)

A version is "**these bytes, read this way**" (ADR-046 §3 / §6). The inputs to version identity grow
in steps — today the hash and the format, **the primary key columns third in ii-b** (§6.4), and the
settled type **fourth**.

**Adding settled types as-is would break the record.** Changing a settled type moves neither the
hash nor the format, so no version stands up, only `resource_version.schema` is overwritten, and the
version can no longer answer "what was this read as". A settled type is a human-decided way of
reading, with the same nature as the format, so it needs to become **an input to the gate**.

**There is one place to add it**: `sameVersionIdentity` (`@kukan/shared`). The version gate and a
revert's settled test go through the same function (§7.2 decision 5), so neither can be left
comparing the old set.

#### Settle operations must be batched into one version

This is what decides the UX. A settled-type change **does not change the bytes**, so it corresponds
to the state where an existing version owns the live object, and version creation necessarily goes
through the **copy path** (ADR-043 §1 — take an object nobody owns, copy one that is already owned).

In other words, **one settling = one version + one copy of the same bytes**. If an administrator
settles five columns one at a time, five versions and five copies pile up.

The UI is therefore designed so that **several columns are selected together and one application
makes one version**, rather than "settle each column immediately". This constraint is decided ahead
of the choice of where to store it (§6.2), and it means per-column partial updates are not wanted in
the first place.

### 6.6 Recording on the version why it was not ingested (new in ii-b)

**When the ingest rejects a version, record the reason in a dedicated column.** The sweep reads it
and excludes the version from its targets.

- Column: **`lake_ingest_reason`** (`key-missing` / `key-null` / `key-not-unique`; null for versions
  that were ingested and for unprocessed ones)
- Writer: **the Lake step**. It does not touch `no_table_reason`, which the interpretation writes
- Sweep: add `no_table_reason IS NULL AND lake_ingest_reason IS NULL` to its condition
- **Never cleared automatically. Written once.** Not cleared by a key-specification change either
  (below)

**There are three reasons, and all the checks are done before the ingest.**

| Reason           | Condition                                                                          |
| ---------------- | ---------------------------------------------------------------------------------- |
| `key-missing`    | The version's schema **has no key column** (dropped or renamed in a later version) |
| `key-null`       | A key column contains NULL                                                         |
| `key-not-unique` | The key tuple is not unique                                                        |

**`key-missing` needs to be its own reason.** It happens routinely that the key columns a version
froze do not exist in that version's content — the publisher need only drop or rename a column.
**Issuing `MERGE` in that state produces a binder error, and it is retried hourly with no reason
recorded.** That is precisely the accident `lake_ingest_reason` was created to prevent (see "the
reason for 6.6" below).

**The check is a column-name comparison against the version's frozen schema
(`resource_version.schema`)** and does not need to read the content. It is the only one of the three
that can be answered before opening the ingest path.

What follows is the reasoning.

#### The reason for 6.6

**It is a mechanism to stop the sweep retrying forever.** `pendingLakeIngestQuery` picks up versions
that are "active with a null `ducklake_snapshot_id`". A version not ingested because of a NULL in a
key column matches that condition forever, being queued hourly and skipped every time. It is the
same shape of accident as #423, where `pendingLakeIngestQuery` and the ordering check on the ingest
side were brought into line.

The existing `NoTableReason` values (`no-columns` / `too-many-columns` / `too-large`) escape this
today because **they can all be written as predicates over the frozen schema** (column count, size).

**Key validation does not fit that shape.** `key-null` can be made a predicate, but
`key-not-unique` cannot — the frozen schema holds only a per-column `distinctCount` and cannot
answer whether a composite key's combination is unique (§6.4). Extending the sweep's `WHERE` clause
one reason at a time dead-ends here.

Therefore **record the reason on `resource_version` and have the sweep exclude versions with a
recorded reason**.

**But it must not ride along on the existing `no_table_reason`.** That column is written by the
interpretation and **is cleared when a re-interpretation finds a table** (`recordVersionSchema`
spells "none" as null; the reason is written in `build-context.ts`). Putting a key-invalid reason in
the same column would erase it on every re-interpretation. On top of that the writer differs, and
the two paths run in **opposite order**:

| Path                               | Order                                                   | If it rode along                  |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------- |
| The main path (`process-resource`) | Recorded at Interpret → the Lake step ingests **later** | There is nowhere to write it      |
| The retry (`retry-lake-ingest`)    | Ingest → record                                         | Overwritten with null right after |

**Whoever discovers it writes to their own column.** The existing three reasons can stay predicates
(they work), and whether to persist `no_table_reason` can be decided independently of this column.

**This column is never cleared automatically. It is written once.** Unlike interpretation, however
many times the same bytes are re-ingested the key is still invalid and the reason is the same every
time, so there is no point clearing it to let the sweep try again.

**Not cleared by a key-specification change either.** Changing the key **stands up a new version**
(§6.4), and that version is ingested with the new key. Going back and re-ingesting rejected past
versions would violate "the diff semantics of past versions do not change retroactively", and in a
layer 2 where v1..v4 use the old key and v5 the new one, only the v4 → v5 diff would straddle key
schemes (the first stage of §7 treats that boundary as a degradation).

**Rejected versions therefore stay out of layer 2.** All that is lost is the row-level diff with
that version as an endpoint, and the three-stage fallback of §7 absorbs it (the content is in layer
1, and downloads and listings are untouched). **If someone wants to re-ingest past versions after
fixing the key setting, an operator does it explicitly** — it must not happen automatically, and
whether to build an entry point for it is a §14.1 decision.

## 7. Step 4 — Diff Extraction (three-stage fallback), the Diff API and the Diff UI

Implements the three-stage fallback of ADR-043 §3-6.

1. **Both ends were ingested with the same key** → **match the content at both ends on that key**.
   Produce the from / to content with `AT (VERSION => …)`, `FULL OUTER JOIN` on the primary key and
   count **additions, removals and changes**. A change is decided by `IS DISTINCT FROM` on the
   non-key columns (the same shape as the predicate on the ingest side; `keyed-load.ts`).
   **`table_changes` is not used** — see "diffs are produced by matching the endpoints" below.

   **The decision is not "do both ends have a key" but "do the `lake_key_columns` at both ends
   match".** As §6.1 says, changed rows can only be produced when both ends were ingested with the
   same key, and if the key specification changed the semantics switch at that boundary. **Two ends
   with different keys degrade to the second stage** (`keyed: false`) — "changed rows" counted under
   two different identification rules is a number belonging to neither. The same applies when only
   one end has a key.

2. **No primary key, or the keys at the two ends differ** → full replacement + a statistical summary
   ("x rows added, y rows removed out of N"). Row correspondence is decided only by matching
   row-content hashes, and **"the number of changed rows" is not counted** (without a primary key,
   a change cannot be distinguished from an addition plus a removal; we do not fabricate a change
   history by guessing).
3. **Schema change** (columns added/removed, types changed) → abandon the row diff and record it as
   **a new version plus a schema change**.

**The diff API (new)**: `GET /resources/:id/versions/:v/diff?from=<v'>` (`from` defaults to the
preceding version).

- Returns: `{ keyed, addedRows, removedRows, changedRows?, schemaDiff, sampleRows }`.
  **`keyed` was put in ahead of time in ii-a** (always `false`). The absence of `changedRows` alone
  cannot distinguish "not measured because there is no key" from "there is a key and zero changes",
  so ii-b widens the type of `keyed` and returns `true` along with `changedRows`.
- **The SQL is only fixed queries assembled by the server** (the only parameters are version
  numbers). Raw SQL from users/AI never touches DuckLake (the ADR-032 sandbox is unchanged, §10).
- The visibility check goes through the same path as ADR-017/032. The primary consumer is
  administrators (quality, auditing).

#### Diffs are produced by matching the endpoints

**`table_changes` is an event log, not a diff.** There are two reasons the numbers do not add up,
and neither is fixed by `DISTINCT rowid` — that is deduplication for the two-statement form of
§11-2.1 reporting the same row several times
([ducklake#1387](https://github.com/duckdb/ducklake/issues/1387)), and it does nothing for events
that ought to cancel out semantically. Every number below is after deduplication.

- **The start is inclusive.** `table_changes(from, to)` includes the events `from` itself wrote.
  **It is wrong even for the default adjacent versions** — with 20,000 rows × 100 versions, v99 →
  v100 reports 300 against a true value of 200 changes. **This is per the specification and is
  stated in the documentation** ("two bounds: the start snapshot and the end snapshot
  (inclusive)"). There is nothing to raise upstream; **the mistake was ours, reading an event-log
  boundary as a diff boundary**
- **Events do not cancel out across a range.** A row that changes and changes back, or is added and
  then removed, is a zero difference between the endpoints but leaves both events in the log. With
  v1=(1,a) → v2=(1,b),(2,x) → v3=(1,a), v1 and v3 are completely identical yet it reports 1 added,
  1 removed, 1 changed. In a shape where each version changes 100 rows and the next reverts them
  (20,000 rows × 100 versions), v0 → v100 reports **10000** against a true value of 100 changes

**Matching the endpoints is correct, and it is also faster** (20,000 rows, 100 versions, local
catalog):

| Diff                         | `table_changes` (start corrected) | Endpoint `FULL OUTER JOIN` |
| ---------------------------- | --------------------------------: | -------------------------: |
| Adjacent (v99 → v100)        |                           26.3 ms |                **20.4 ms** |
| 100 versions apart (v0→v100) |                           38.9 ms |                **15.2 ms** |

The number of events grows with the distance between versions while an endpoint comparison grows
only with the row count, so **the gap widens as the range grows**. The diff API defaults to the
preceding version but takes a `from`, so wide ranges arrive routinely.

**As a by-product, the diff API no longer depends on ducklake#1387.** The `DISTINCT rowid` of
§11-2.1 remains as knowledge used when verifying an ingest, but the design in §7 does not assume it.

**And the ii-a implementation is already in this shape.** `buildDiffQuery`
(`packages/lake/src/diff.ts`) opens both ends with `AT (VERSION => …)`, attaches ±1 markers and
folds them to a net — `table_changes` is never used. What ii-b changes is **only the unit of
folding**, from "the whole row content" to "the declared primary key", and the keys whose net is
non-zero and that exist on both sides become the changed rows. **What this section rejects is the
design note in this spec, not the implementation** (the first stage above originally said
`table_changes`).

**In a table where every column is the primary key, "change" cannot occur by definition.** There
are no non-key columns to compare, so there are only additions and removals and `changedRows` is
always 0. The ingest side has no update clause for the same reason (`keyed-load.ts`, §11-2.4).

### 7.1 The diff UI (administrators, included in ii-a)

Extend the version history built in Phase i,
`apps/web/src/components/dashboard/dataset/resource-version-history.tsx` (the version list inside
resource editing: version, created timestamp, size, origin, purge). No new screen is built — having
the diff next to the version is the most natural path, and it reuses the Phase i work directly.

- **Open "the diff against the previous version" from each version's row** (row expansion, or a diff
  button). `GET /versions/:v/diff` is called **on demand** only when it is opened. Fetching diffs
  for every version while rendering the list would run (number of versions) × DuckLake queries and
  be heavy.
- **What is shown**: the `+N rows / −N rows` summary, badges for schema changes (columns
  added/removed, types changed) and sample rows (a few representative additions and removals). With
  a primary key (ii-b) changed rows are shown too.
- **In the keyless stage "changes" are not displayed** (as in the second stage of §7, only additions
  and removals can be distinguished). We do not show a false "N rows changed" metric in the UI
  either.
- **When it is hidden**: non-tabular versions, versions not yet ingested into layer 2 and purged
  versions get no diff, with the reason shown ("this version is not tabular", "this version has been
  purged").
- Showing diffs on the public pages for viewers is Phase iii (§15). ii-a stays inside the dashboard.

### 7.2 Moving content is done by issuing a version (a premise of ii-b)

**A version row's `ducklake_snapshot_id` is written once.** It points at the snapshot that holds
that version's content, and no operation rewrites it afterwards.

There are six decisions. **The reasoning has been replaced since the original** (below).

1. **A version row's `ducklake_snapshot_id` is written once.** No operation rewrites it
2. **A rollback does not "go back"; it "publishes that content again".** It creates a new version
   holding the target version's content
3. **Operations that move content go through the ingest path.** They do not write the destination
   back onto a version row. The same applies to the step-down of a purge (not a publication, so it
   creates no version). The method has the three branches below
4. **`superseded` is abolished**, and the rule where `restoreTo` refuses a `superseded` version (no
   redo) falls away with it. **What goes is the "step off everything above the destination"
   computation, not the definition of live** — live is still **the version owning the object the
   live pointer names**, which during a purge can be a `purging` one (`isLive`, §9.6). What the
   change moves is **layer 1's automatic fallback after a purge**, and that is **the highest
   `active` version** (decision 6). For new history it coincides with "the highest not purged"
5. **A resend asks "already at the destination" of the content** (ADR-044 §4). Since a revert
   issues a version, live never stands on the version that was named, so asking by number makes
   every resend a 409. **What is compared is every input the version gate takes** — today hash and
   format, in ii-b the key columns as well. **Not a fixed list of columns but the gate's own
   function** (`@kukan/shared`): written separately, the day an input is added to the gate leaves
   settled comparing the old set, and **a version differing only in its interpretation can no
   longer be restored**. No idempotency key, no operation ledger. Matching content is also not
   enough on its own — live standing on the object of a version being purged is not settled, since
   the bytes it serves are about to be destroyed
6. **Existing `superseded` rows are converted.** The rows the old scheme left behind are moved to
   the shape a new-scheme revert would have produced (back to `active`, live's content issued as a
   new version). **Left alone, every predicate over version state carries two regimes at once** —
   in implementation the count of fixes equalled the count of new holes (the table in ADR-044 §4).
   It needs an object copy, so it is a backfill like the v1 pass, not SQL. **Until it has run the
   readers keep the old predicates** (the order cannot be reversed). **The unit is the resource and
   there are no exceptions** — resources where no version owns live are included, and there the
   object is **taken over by a new version** rather than copied (`restored_from` is null). Exclude a
   shape and its `superseded` rows stay forever, leaving the three states unreachable (the table in
   ADR-044 §4). **The issue goes first and the flip second** — once issued, the topmost version owns
   live, so no broken window opens, and the question ("does the topmost version not purged own
   live?") is unchanged by the flip, so the two can be split and still resume. **The taking-over
   branch copies an interpretation only on a matching `sourceHash`** (the v1 pass's condition): a
   stale zero-column schema would drop that version out of the layer-2 sweep for good

Those are the decisions. What follows is the reasoning, and you can implement without reading it.

#### The reasoning for 7.2 (measured)

> 🔴 **The first piece of reasoning this section originally gave no longer holds.** It was:
> "rewriting it makes `table_changes` silently return empty" — when `standLakeTableOn` overwrites the
> rollback target version with a new snapshot ID, the version order (1 < 2) and the snapshot order
> (6 > 5) invert, and `table_changes(6, 5)` returns **0 rows rather than an error**. The observation
> itself is correct (the reverse direction, `table_changes(5, 6)`, returns 10 rows).
>
> **The moment §7 changed diffs to endpoint matching, the path to that failure disappeared.** An
> endpoint comparison does not depend on the ordering of snapshot IDs. Measured (a 3-row table with
> v1's record overwritten from 1 to 3, inverting it against v2 = 2):
>
> | Diff                         | Endpoint `FULL OUTER JOIN`        | `table_changes` |
> | ---------------------------- | --------------------------------- | --------------- |
> | After the overwrite (3 → 2)  | `added 1 / removed 1 / changed 1` | **0**           |
> | Before the overwrite (1 → 2) | `added 1 / removed 1 / changed 1` | —               |
>
> **The endpoint comparison answers correctly even with an overwritten ID.** What follows therefore
> re-establishes this section's decisions **on different grounds**. Two grounds remain, and **both
> are weaker than "the diff breaks silently"**.

**First, moving content with `CREATE OR REPLACE` is exactly the write path ii-b rejected.** It
rewrites the table's whole current content, so every file is replaced — §11-2.4 chose "predicated
`MERGE`" because this costs 315× the writes on append-dominated data. A rollback would write a full
copy of the table into layer 2 on every publication, whereas **going through the ingest path costs
only the difference**.

**Second, abolishing `superseded` can be justified independently of diffs** (below). ADR-044 open
issue 7 (a version stepped down before it entered layer 2 can never enter it again) is a defect
that comes from the state existing at all.

**And write-once is not an independent decision but a consequence.** If a rollback issues a
version, the new version receives its snapshot exactly once at issue time — **there is nothing to
write back in the first place.**

**Given all this, a rollback takes the form of "publish that content again" rather than "go
back".** Rolling back to v1 does not touch v1's record; it **issues a new version v(N+1) holding
v1's content**. Snapshots are assigned in version-issue order and are never rewritten. **Diffs do
not depend on that ordering** (above), but snapshot IDs lining up in version-issue order remains a
property that the ingest's ordering check and the maintenance functions read.

**As a side effect, a known degradation disappears too.** Performing a rollback with
`CREATE OR REPLACE TABLE … AT (VERSION => …)` makes it look like an all-row insert in the change
feed (§14.0). Doing it as a publication goes through the normal keyed ingest path (a predicated
`MERGE`), so **a diff spanning the rollback becomes a correct row diff**. The same content move,
measured both ways (a 3-row table, v3 = a re-publication of v1's content):

| Diff                            | Done as a version issue                                  | Done by rewriting the table |
| ------------------------------- | -------------------------------------------------------- | --------------------------- |
| v2 → v3 (the rollback itself)   | `delete=1 insert=1 update_preimage=1 update_postimage=1` | `insert=3`                  |
| v3 → v4                         | `update_preimage=1 update_postimage=1`                   | —                           |
| v1 → v4 (spanning the rollback) | `delete=2 insert=2 update_preimage=3 update_postimage=3` | —                           |

**Layer 1 needs no new mechanism.** `resource_version.storage_key` already works by the rule "the
object this version owns, copied if another version already owns it" (ADR-046 §3), the same shape
already used when an interpretation change did not move the content.

**The rule is not limited to rollbacks.** Once a rollback issues a version, **the purge's step-down
is the only operation left that moves a table's current content** (§9.1 step 4): it removes the
version layer 2 stands on and re-loads the content of layer 2's own step-down target through the
ingest path. It is not a version issue (a purge is not a publication), so **the landing snapshot is
named by no version row** — **§11-3 already covers this case with "always keep the newest
snapshot"**.

> **The self-repair before an ingest (the former `standOnBase`) is no longer needed.** A table's
> head diverged from its base because moving content was a path of its own, separate from issuing a
> version. Once a rollback issues a version, and an ingest refuses to load while a higher ingested
> `active` version exists, the head always holds **the contents of the `active` version loaded last**
> — which is exactly the base of the next ingest. A purge's step-down lands there too. The only
> divergence left is a purge that failed partway, and what repairs that is the retry of that purge
> (§14.1-16).
>
> **"Loaded last" is the version whose recorded snapshot is highest, not the highest version
> number.** They coincide for write-once data and part company where an id the old scheme rewrote
> survives (§9.1). **Reading the base as "the preceding `active` version" there loads onto contents
> the table does not hold.**

#### A re-load has three branches, and one of them uses `CREATE OR REPLACE`

**The source is always the table itself read at that version's snapshot** (`t AT (VERSION => n)`).
Rebuilding the Parquet out of layer 1 would be a re-interpretation, and not a price a purge's
step-down should pay. Which method applies is decided by **the two questions the ingest already
asks** (did the columns move, do both ends share a key):

| Base and destination                                | Method                                                       | Written   |
| --------------------------------------------------- | ------------------------------------------------------------ | --------- |
| Same schema, **the same non-null key at both ends** | Two predicated `MERGE` statements in one transaction         | A delta   |
| Same schema, different keys or either keyless       | `DELETE` + `INSERT ... AT (VERSION => n)` in one transaction | Every row |
| Different column sets                               | `CREATE OR REPLACE TABLE ... AT (VERSION => n)`              | Every row |

**Every branch reads that version's contents out before it writes.** A `DELETE` inside the
transaction takes the same table's `AT (VERSION => n)` with it (measured, §14.0), so reading while
deleting **silently empties the table** whenever the current contents and `n` share files. ii-a
replaces wholesale and never shares, so it does not bite there; ii-b's keyed load always shares.

**Different keys do not get a `MERGE` because the validation only covers one side.** Key
uniqueness is checked against **the incoming version** and nothing else (§6.6), so a base loaded
under a different key may hold duplicates under this one. The `MERGE` would then touch one target
row twice — silently dropping one today, a cardinality error after the DuckDB update (§14.0).
**This is the same rule §7 applies to diffs — use the key only when both ends agree on it — so the
move and the diff share one question.**

**The third is unavoidable.** With different column sets there is nothing to match rows on and
nothing to insert into, and the `INSERT` fails rather than quietly doing something else.
**This section originally forbade `CREATE OR REPLACE` for every content move, which that branch
cannot satisfy.** The prohibition is a rule about the first two.

**What it costs is the change feed, not the history.** Across a whole-table replace a change reads
as every row inserted (§14.0), but time travel to either side of it still answers — and the diff
API compares endpoints, so it is unaffected.

All three branches sit as assertions in `merge.ducklake.test.ts` (the content comes back, it folds
into one snapshot, and the snapshot stepped off stays readable). They are claims about someone
else's implementation, so left in prose they would go quietly stale on a DuckLake release.

**`superseded` becomes unnecessary.** Not as a reduction in states, but because **the computation
that state was carrying disappears**. The current rollback (v1..v5 `active`, live = v5, going back
to v2) works like this:

```
one transaction:
  a. stepOffAbove(below = 2)
     UPDATE resource_version SET state = 'superseded'
      WHERE state = 'active' AND version > 2     ← v3, v4 and v5 drop at once
  b. restoreLiveFromVersions
     → newestActiveVersion (the highest version with state='active') returns v2 thanks to a
     → the live pointer moves to v2's object
```

**`superseded` is not "a record that was rolled back" but a working variable to make
`newestActiveVersion` answer v2.** That is why it is applied before the pointer moves, and the
comment in the implementation says as much: "step off before going back — the restore target is the
newest `active` version at or below the destination, so everything above it must be out of that
set". If versions move forward, that search does not exist at all. The operator names v2 and its
content is simply issued as a new version, so **there is no set to narrow.**

**What becomes a single sentence is layer 1's automatic fallback after a purge — the highest
`active` version.** `stepOffAbove` disappears. **Since new history never produces `superseded`, that
coincides with "the highest version that has not been purged"** — coincides, not the same predicate.
Retained old rows part the two, so **automatic targets are read as `active`** (decision 6, the table
in ADR-044 §4).

**Live itself is not that sentence.** Live is the version owning the object the live pointer names,
and mid-purge that version is `purging` while no `active` version is live at all (the shape `isLive`
pins, §9.6). **Under one name, the confirmation screen misstates what happens.**

**The price is that the restore target of a purge changes.** After rolling v5 back to v2 and
issuing v6, purging v6 returns live to **v5, not v2** (today v3..v5 are `superseded`, so it jumps
all the way to v2). Read as a plain append-only log of history, "removing the top returns you to
the previous published state", and chronologically that is the honest answer. **Content that was
supposedly set aside can come back as current** either way, so rather than encoding it in a state we
**show it on the purge confirmation screen** — "live will return to v5 (published on YYYY-MM-DD,
already rolled back)". The confirmation screen already deals with restore targets (§9.6).

**Reachability does not change.** A `superseded` version can be downloaded today too
(`getDownloadTarget` only refuses `purged`) and appears in the version history. All this state
removed was the "newest version number" label (`latestLiveVersionAgg`) and the restore target.
**If the intent is "this must never be served again", the operation is a purge, not a rollback.**

**The `restoreTo` rule of "there is no redo" falls away too.** Today a `superseded` version cannot
be named as a restore target, but that constraint existed precisely because a rollback
**renumbers** versions. If versions move forward, "publish that content again" is unambiguous and
there is no reason to refuse.

**There are two costs.** Every rollback adds one version number and one layer-1 object (a round
trip grows them linearly). And **ADR-044 has already been released** (v0.11.x), so the contract
change and the handling of versions whose snapshots have already been rewritten must be decided.

## 8. Step 5 — Type Determination and Presenting "Type Demotion" Choices (ii-c)

The interpretation infers a column type for each version (`integer` / `float` / `boolean` /
`string` / `date` / `timestamp`; since ADR-046 DuckDB's sniffer does this, and `date` / `timestamp`
were added there). The inferred type can change between versions (e.g. a column `amount` that was
all integers in v1 gains `"N/A"` or a thousands separator `"1,234"` in v2 → v2 is `string`). This is
a **column type demotion** (integer → string) and in DuckLake it lands as a schema change, i.e. the
"abandon the diff, new version" of §7-3.

- **ii-a/b**: a type change is **only recorded as a schema diff** (the demotion is accepted
  automatically and a new version is created).
- **ii-c (the choice-presenting UX)**: on the replacement confirmation, present "the type of column
  `amount` changes from integer to string" and let the administrator choose:
  1. **Accept the demotion** (ingest with the column as a string. Default and safe)
  2. **Treat the offending rows as errors** (keep the type and present the outlier rows as
     "inconsistencies" in the diff)

  Type **promotion** (string → integer, when every row became an integer) can be detected the same
  way, but the default is "do not change" so as not to break existing data. The UX is integrated
  with the replacement flow of Phase iii.

The lattice of type promotion/demotion (which type can move to which) and the function that decides
it deterministically live in `packages/shared` and are used by both Extract's inference and the
diff.

## 9. Step 6 — Propagating a Purge to Layer 2

Add the handling of layer 2 for tabular resources to the Phase i purge (sysadmin only, tombstone
approach, ADR-028).

**What a purge claims is unfetchability, not erasure of the bytes in layer 2.** What happens per
layer is as follows, and **only layer 2 is not a "delete"**.

| Layer                          | What the purge does                  | Guarantee                        |
| ------------------------------ | ------------------------------------ | -------------------------------- |
| Layer 1 (the canonical object) | `storage.delete`                     | **Physical deletion**            |
| Layer 3 (the preview Parquet)  | `deleteMany`                         | **Physical deletion** (\*)       |
| The search index               | Discarded                            | **Physical deletion**            |
| Layer 2 (DuckLake)             | Null out `ducklake_snapshot_id`      | **Unreachable from the product** |
| Layer 2's Parquet              | Attempt expire → `cleanup_old_files` | **None (best effort)**           |

**(\*) The "physical deletion" of layer 3 is about the current preview.** A preview created by an
intermediate version and already parked is not hurried along by the purge, so it **remains for up to
one hour plus the sweep interval** (§9.8). Layer 3 has no delete vector so it can be removed — it is
not that it cannot be, but that **we do not yet remove it immediately**. Open issue §14.1-7 adds an
immediate sweep at purge time to make it match the table.

**Erasing layer-2 bytes cannot be guaranteed per resource.** DuckLake snapshots form a catalog-wide
sequence, and one snapshot describes **the state of every table at that point in time**. A snapshot
retained for another resource therefore keeps referencing the target resource's files (measured in
§9.2). `expire` + `cleanup_old_files` is **capacity reclamation that frees what it can free**, not
a means of erasure.

**And on top of that, we do not call it "completely deleted".** Rows can remain in layer 2's
Parquet, so both the UI and the audit log **avoid the phrases "physically deleted" and "completely
deleted", and state explicitly that data may remain in layer 2** (§9.5 / §9.6). **Reporting
"completely gone" for something that has not disappeared is the one failure this section exists to
prevent.**

**Calling the operation "deletion" is not itself forbidden.** In Japanese 削除 does not imply
complete erasure — the language has 論理削除 for exactly this — and in English "delete" is what
every other destructive control in this product is called. "Purge" reads as jargon to whoever is
about to confirm it, which is a different failure and does nothing about the guarantee-word one.
**What is forbidden is the claim of completeness, not the name of the operation.**

**Deleting a prefix in the data directory outside DuckLake's management is forbidden.** The catalog
would never learn the files were gone, and time travel and maintenance functions for other resources
would hit dangling references. **The only write path into layer 2 is DuckLake.**

### 9.1 Purging a version

**An administrator names a version and makes it unfetchable. The unit is one version, not a range.**

1. Claim the version with `purging` (the ADR-028 durable claim; `purgedAt` / `purgedBy` /
   `purgeReason` are recorded on the row at this point)
2. **Delete the layer-1 bytes** (`storage.delete`) — **before** moving the live pointer. This makes
   an interruption fall on the side of "live points at a deleted object (cannot be served)"
3. **Only when the target was the version standing as live**, discard the derivatives (preview,
   search index, regeneration request) — before the pointer move, for the same reason. **Not
   discarded for an intermediate version.** The preview and search represent the live content, and
   purging an intermediate version does not change that (§9.8).
   **The confirmation wording branches here too** (§9.6)
4. **Step layer 2 down** (`purgeFromLake`) — **only when layer 2 stands on that version**, **re-load
   the content of the layer-2 rollback target through the ingest path**; `DROP TABLE` if there is no
   target. **The landing snapshot is not written back onto a version row** (§7.2; a step-down is not
   a publication so no new version is created either — that newest snapshot is kept by §11-3). Then run
   **`reclaimInSession`** (expire snapshots that no surviving version names →
   `cleanup_old_files(cleanup_all => true)`)
5. Move the live pointer to the **layer-1 rollback target**
6. Leave a tombstone row and null out `ducklake_snapshot_id`

**The rollback targets of steps 4 and 5 are different things.** They are not the same "preceding
surviving version".

|                                        | Definition of the rollback target                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| **Layer 1 (step 5, the live pointer)** | The highest **`active`** version                                                  |
| **Layer 2 (step 4)**                   | the **`active`** version whose **`ducklake_snapshot_id` is highest and resolves** |

**Layer 2's "highest" is read off the recorded snapshot, not the version number.** What the table
holds is the contents of the version that was **loaded last**, and the highest snapshot is what names
it. The two coincide for write-once data and part company wherever an id the old scheme rewrote
survives the conversion — and taking the version number there **puts the step-down and the next
purge's question out of step**. With v1@13 and v2@9 active, purging v3@14 would come down onto v2
while v1 still records the higher id, so the following purge of v2 reads "something was loaded after
me" and leaves the purged rows as the current contents. **Stepping to the highest id keeps that from
arising**: after a step-down the head still holds the rows of the highest-recorded surviving version,
which is exactly what the next purge asks about, and an ingest maintains the same relation because
its snapshot is the catalog's newest. **The one state that escapes it** is an unresolvable id left
above the version stood on, which belongs to §11-5 and open issue 15.

**Confusing them permanently loses layer 2's current contents on an ordinary purge.** With v1
ingested, v2 live but not ingested (too large, not tabular, or in ii-b an invalid key) and v3
ingested, purging v3 gives: layer 1 may return to v2, but **layer 2 should return to v1**. Stepping
layer 2 down using layer 1's target gives "v2 has no snapshot → no target → `DROP TABLE`". And
`DROP` does not null the `ducklake_snapshot_id` of surviving versions, so **the sweep does not pick
it up either** (its condition is `ducklake_snapshot_id IS NULL`). It is the same permanent loss as
the restoration in §11-5.

**What a `DROP` costs, though, is only the current contents.** Time travel and two-endpoint diffs on
the retained snapshots **read through a `DROP`** (after expire + cleanup as well, and after the name
is re-created; measured, and pinned in `maintenance.ducklake.test.ts`). What is lost is the head, and
what makes that permanent is that nobody puts it back.

**`DROP` is acceptable only when there is no layer-2 rollback target at all.** And **when there are
candidates but none of them resolve, fail rather than `DROP`** — dropping there leaves the version
rows carrying unresolvable ids, which the sweep (conditioned on `IS NULL`) passes over, so nobody can
repair it. §11-5's repair (nulling unresolvable ids) is not implemented, so leaving the version in
`purging` for the operator to see is the correct answer (open issue 15).

**A retained `superseded` version is neither automatic rollback target until it is converted.** New
history never produces one, and the rows that remain are moved to the new shape by a backfill (§7.2
decision 6). Until then a reclaim's retained set keeps their snapshots, so **their diffs still
read**, and **an operator can still name one explicitly** (`restoreTo`): not restoring automatically
and refusing to be named are different things (ADR-044 §4).

**With no target left, only a purge drops the table.** A purge owes unfetchability, so it drops, and
the empty table states the fact that layer 2 has no current contents. **A revert in the same state
does not** — the versions it retracted are not `purged`, so it owes nothing of the kind, and with
nothing live no reader resolves to the table's contents anyway (ADR-043 §5). **Not because it could
not** (a `DROP` costs no history). What is left of it is a ii-b premise, in open issue 16.

**Whether to step down is not decided by live either.** Layer 2 stands on the newest version it
successfully ingested, so that version and live **diverge in both directions** — a live version may
not be in layer 2, and if no version above it reached the lake then **an intermediate version is the
top of layer 2**. Not stepping down in the latter case leaves the purged rows as the table's current
contents, and ii-b's `MERGE` loads the next version on top of them. The question is "was no other
version loaded after this one", not a question put to the pointer. **Whatever state that row is in
now** — a purge takes its version out of the active set when it is claimed and steps the table down
later, in a worker, so in between the contents belong to a row that is not `active`. Only the
_destination_ may be restricted to `active`.

**And when the highest snapshot belongs to a `purging` version, the record cannot say which side of
the step-down it is on**: step 4 commits in DuckLake, step 6 nulls the id, and a failure between them
releases the claim with the row unchanged. **A reader asking whether both ends share a key treats
that as "they do not"** — replacing the contents is sound either way, and the version keeps its own
key for the load after it.

**It is asked of the
recorded snapshots** — what the table holds is the contents of the version loaded last, and the
highest recorded id is what names it. Asked of the version numbers it parts company with the
step-down target wherever an id the old scheme rewrote survives (see "Layer 2's 'highest'" above).

**expire is performed, but it is not what carries "making it unfetchable".** That is carried by
nulling `ducklake_snapshot_id`: both diffs and time travel resolve snapshots from version rows, so
**the moment it is null, every path with that version as an endpoint disappears**. expire is the
cleanup that keeps snapshots no version names any more from piling up.

**Computing the retained set needs no special case.** At step 4 the target row is `purging`, and
reclaim re-derives the retained set from **the version rows that are still alive**, so its snapshot
is naturally read as unreferenced (the same goes for `purged`). The set is defined as "**versions
that have not been purged**", not "current versions" — a diff resolves the versions at both ends
into snapshots to read them, so dropping non-current versions would break comparisons
(`lake-reclaim.ts` implements this set as **anything that is not a tombstone** — everything but
`purged` / `purging` — which is where a retained `superseded` row keeps its snapshot; §7.2
decision 6).

**expire does not necessarily reach the layer-2 bytes. There are two reasons, and both are design
properties.**

- **Merges redirect the history.** Because the ingest runs `merge_adjacent_files`, that version's
  delta files have usually already been folded into a consolidated file and their catalog rows are
  gone. The consolidated file is not freed because retained snapshots older than N keep referencing
  it (§11-2.3)
- **Snapshots are catalog-wide.** A snapshot retained for another resource keeps referencing the
  target resource's files (§9.2)

**The expire + cleanup of step 4 is therefore best-effort capacity reclamation, not a guarantee of
erasure.** The purge completes even if it fails or does not reach — what decides completion is the
nulling in step 6.

### 9.2 Layer-2 bytes cannot be erased per resource

**DuckLake snapshots are catalog-wide, not per table.** A commit to any table creates a new catalog
snapshot, and that snapshot describes **the state of every table at that point in time**. A snapshot
retained for one resource therefore keeps referencing another resource's files. It shows up
directly in the catalog metadata (measured: create `a` → create `b` → append to `b` → `DROP` `a`):

```
file 0  table=a  alive for snapshots [1, 4)
file 1  table=b  alive for snapshots [2, ∞)
file 2  table=b  alive for snapshots [3, ∞)
```

Snapshots 2 and 3, which `b` needs, sit inside the lifetime of `a`'s file. **Even if you `DROP` `a`
and expire with `b`'s retained set, `a`'s rows stay on disk.**

**This fact is pinned by a test** — "leaves one table's rows on the disk because another table needs
the snapshots" in `purge.ducklake.test.ts`. The target rows go 10 → 10, and only when the history of
the table corresponding to `b` is discarded too does it reach 0, at which point `b`'s own content
still remains (a file outlives the snapshot that named it). **If DuckLake ever makes file lifetimes
per table, this test fails. That is the day the guarantee can be revisited.**

**`DROP`ping and rebuilding from layer 1 does not erase it either.** Rebuilding only writes new
files, and what holds the old files is another resource's retained snapshots. Where §9.9 says
"`DROP` the table and rebuild from layer 1 and it disappears", that was **measured on a
single-table catalog** and does not hold for the production catalog layout.

**"Expire just that interval extra" does not work either.** Freeing a contaminated file requires
expiring every snapshot inside its lifetime, and that includes **snapshots named by surviving
versions of unrelated resources**. Measured (4 resources publishing 8 versions each, alternating),
the widest interval contained 28 snapshots belonging to surviving versions, **21 of them — three
resources' worth — belonging to other resources**. Every resource that published within the interval
is affected, so it grows with the number of resources and the publication frequency.

Strictly speaking what is lost is not a purge — the layer 1 of the other resources is untouched, and
what breaks is layer 2's diffs and time travel (§4-4 nulls `ducklake_snapshot_id` and it degrades to
the three-stage fallback of §7). Even so it is a trade that **sacrifices the history features of
unrelated resources to erase one resource's bytes**, and we do not take it.

**This coupling is a feature of DuckLake, not a defect.** What catalog-wide snapshots implement is
**multi-table atomicity and point-aligned reads**. Measured: wrapping writes to two tables in one
transaction consumes only one snapshot, and **no half-finished state can be observed by time
travelling to any snapshot** (no version has one table updated and not the other). In Iceberg /
Delta, snapshots are per table, so joining two tables at the same point in time requires the
application to keep a mapping. This is the return on the catalog being a real SQL database.

**And we are not using it.** Layer 2 is one table per resource, and we neither write several tables
in one transaction nor join across tables. It is a trade where **we lose the granularity we want
(per-resource retention and erasure) in exchange for a guarantee we do not use.** The only way to get
the granularity back is to split the catalog per resource, but the catalog is one set of PostgreSQL
schemas, so we would gain a schema per resource, need an ATTACH per query, and lose the instance
cache in `connection.ts` (it would also collide with the connection budget of ADR-041). **We do not
take it.**

**It is not that there is no way to erase the bytes; we simply do not offer it as a product
feature.** Folding live and then expiring everything before it does erase them (measured). But
expire is catalog-wide, so **every resource loses its layer-2 history** and the sweep picks all of
them up for re-ingest. That is not a price to pay at the request of one resource. The procedure and
the measurements are in §9.7.

**Deleting a prefix outside DuckLake's management is forbidden** (top of §9). It looks cheap, but the
catalog would never learn the files were gone and time travel and maintenance functions for other
resources would hit dangling references.

**Let us be explicit about what this loses.** KUKAN has no operation about which it can say "the
bytes in layer 2 were erased". Layer-2 rows are reachable only by someone who can reach both the DB
and the storage, and the product's path is closed by the nulling of §9.1 — but **that is
unreachability, not erasure**. This line comes straight down into the semantics of §9.5, the UI
wording of §9.6 and how the audit log phrases things.

### 9.3 Deciding the range

**The unit is one version, but the range is an operator's judgement.** In most cases it will be N
through live.

**The upper end cannot be computed.** Deletion requests arrive in natural language. Matching their
content against where and in what form it appears in a version (paraphrases, partial matches,
related information) is a human judgement, and only one end of the range can be named. **N is a
judgement too.**

**Versions moving on unnoticed is the normal case.** A request arrives some time after the content
went out, so the offending rows sit continuously from N through live, and the default assumption is
that **live holds them as current content**.

**Rows that live holds as current content cannot be handled by a purge.** Erasing what live is
serving is not a deletion but **a change of content**, which is a different operation. If live is
included in the range, live returns to the preceding surviving version (the existing layer-1
behavior; if there is no surviving version the resource becomes empty).

**Purging an intermediate version on its own is only meaningful when the content was not carried
forward.** If version N's content lives on in version N+1, N+1 holds the same thing. **Show the
N → N+1 diff on the confirmation screen** — if the offending rows do not appear there as "removed",
they live on in later versions and the range must be widened. It is a firmer brake than a warning
message.

### 9.4 How history is presented

In future, versions that have not been purged will be shown to ordinary users too. A withdrawn
version is **shown as a gap, together with the fact that it was withdrawn**.

```
v7   2026-08-01   1.2 MB   [download] [diff]
v6   2026-07-01   1.2 MB   [download] [diff]
v5   ——           withdrawn (2026-07-15)
v4   2026-05-01   1.1 MB   [download] [diff]
```

**Numbers are not compacted.** `version` is a per-resource sequence with a unique constraint on
`(resource_id, version)`, and it is referenced externally in URLs and citations. Compacting it would
point at a different version. And since the numbers skip anyway, **the gap is visible** even if the
row is hidden — hiding only removes the explanation.

**Diffs fall safe structurally.** Because `ducklake_snapshot_id` is null, a diff with a withdrawn
version as an endpoint cannot be computed. The versions on either side (v4 → v6), meanwhile, have
healthy snapshots at both ends and can be. Version 6's history display becomes "**changes from the
preceding surviving version**", and it says so explicitly. There is no need to fall to the
three-stage fallback of §7; the reference simply moves up.

**The tombstone shows only the timestamp, the reason and who did it.** `hash` is a fingerprint of
the content, so displaying it would let someone verify content identity. `size` carries information
too. If the withdrawal reason is a personal-data incident, it is hidden.

**A rolled-back version is a different thing from a withdrawal, and its content is intact.** Both
are "not current", but they are displayed differently. Once §7.2 lands, a rollback becomes the issue
of a new version, so this distinction is held not as a state but as **that version's provenance**
("v8 is a re-publication of v5's content").

**Provenance is recorded on the row; it cannot be derived.** Versions with the same bytes and the
same interpretation can repeat (ADR-046 §3), so hash, format and key do not settle _which_ version
was re-published — an implementation picking the oldest match and one picking the newest are equally
correct and display different numbers. So the version row carries two columns:

| Column          | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| `origin`        | **`revert`** joins `upload` / `fetch`                       |
| `restored_from` | The version number a revert named; null on every other path |

**`restored_from` is a record for display, not a mechanism.** Nothing reads it to decide anything —
not the purge, not the diff, not the revert itself. It is recorded because **leaving it out cannot
be undone**, and with no read path for the audit log (open issue 6) the history is the only place
that answers it.

**It is not shown when either end is a tombstone.** The rule above hides the hash so content
identity cannot be checked, and "v8 re-published v5" **says the two had identical content** — the
same check by another route. **And the route runs both ways**:

| The purged side         | What the number reveals                                   |
| ----------------------- | --------------------------------------------------------- |
| The re-publication (v8) | The erased v8 held the same content as v5                 |
| The source (v5)         | The erased v5 held the same content as v8, which is alive |

**The second leaks more** — v8 is downloadable, so the erased content is simply obtainable. So
`VersionView.restoredFrom` is **null whenever either row is `purged`**. Unlike `hash` / `size` /
`schema`, which are settled by their own row's state, **this one is settled by two rows**.

**The column on the row stays**: this is exposure, not erasure (the same shape as `purgeReason`,
open issue 6).

### 9.5 Semantics

"Rows written by the purged version remain in layer 2 if they are still current in a later version"
is not a condition we implement; it follows automatically from whether references exist. **What a
version purge claims is unfetchability, not erasure in layer 2**, so this property is accepted as
is. The UI wording is "this makes this version unfetchable", not "this deletes the row data only
this version held".

**No guarantee words.** In the spec, the UI and the audit log alike, this operation is **never
described as "physically deleted", "completely deleted" or "legal deletion"**. Layer 1, layer 3 and
the search index really do disappear, but **the conclusion of the operation as a whole cannot be
"all of it is gone"** — because rows can remain in layer 2. The audit log records the operation, the
target and the time, and states the result as "made unfetchable". **The table at the top of §9 is
authoritative for which layers disappear and which remain.**

**The operation may be named "deletion"** (§9, above). What is avoided is the claim of
completeness, not the plain word.

### 9.6 The UI and the recovery procedure

**A purge cannot be undone.** It deletes the layer-1 bytes, so that version's content can no longer
be fetched from anywhere in the product (rows remain in layer 2 but are unreachable from the
product). The procedure for replacing content that was published by mistake is:

```
1. Download live (if needed)     ← skipping this makes it unrecoverable
2. Purge the target version      → live moves to the preceding surviving version (or empty)
3. Upload a corrected version
```

The confirmation screen covers: the version that disappears, where live falls back to (or that it
becomes empty), prompting the user to download the current content first if they need it, **the fact
that rows remain in layer 2**, and the later-version check of §9.3 (the N → N+1 diff). **Only the
last of those is unimplemented; it is open issue 14.**

**The wording is decided by "is the target live", not by the number or the order of versions.** As
in step 3, derivatives are discarded only when purging the live version; for an intermediate version
neither the preview nor the search index is touched.

| Target                     | What happens                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| live, other versions exist | Delete the canonical copy, preview and search. live moves to the rollback target                            |
| live, the only version     | Same. With no rollback target the resource ends up with no file                                             |
| not live                   | Delete only the canonical copy. The preview and search represent the current version, so they are untouched |

**However, "is the target live" cannot be answered on the client.** The live pointer names an
object, not a version. There are two rules a client would reach for instead, and **each has a shape
that breaks it** (the server decides by who owns the pointer, and there is an integration test for
each shape).

| Rule                           | Where it breaks                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| "the highest version"          | after the newest version is purged: the tombstone stays on top and live is below it       |
| "the highest `active` version" | while a purge is in flight: live stands on a `purging` version, and no active one is live |

**A revert breaks neither.** It moves versions forward, so after one live _is_ the highest version
(§7.2). What breaks them is a purge: its claim creates the state before the pointer moves (the
pointer moves when the worker runs). **Choosing by the count of active versions breaks in the same
shape.**

**Unconverted `superseded` rows break the first one only** — the old revert left versions above
live — and that shape goes away with the conversion (§7.2 decision 6). They do not break the second:
the versions it set aside are not `active`, so "the highest `active` version" stayed live, which is
**why the state was there**.

**In that shape the server's own answer is not assured either.** Where no version owns the live
object the server falls back from the owner to a hash guess (`liveVersion`), and an unconverted
`superseded` row above live holding the same hash takes it, so **`isLive` lands on another version**.
That is the known defect the conversion makes unreachable. **The prediction still holds** — the purge
acts on the same guess — but **the identification, "this is what is being served", does not**.

**What misleads it is not the guess but the unconverted row above live that takes it.** The guess
outlives the conversion — an unowned live object is a permanently normal state (ADR-044 §4) — but
with every version `active` it answers the topmost one, and **the unowned live an unchanged
re-fetch leaves is that version's content** (no version was created precisely because it matched
the latest active one, §7).

**The list API therefore returns `isLive` per version, and the confirmation names the case from it.**
It costs no extra logic — `liveVersion()` (which reads the pointer's owner) is what the purge itself
decides from — and it counts `purging` as well: **a purge in flight is still what is being served
until it moves the pointer.**

**Named, and still said conditionally.** Live can move between opening the confirmation screen and
confirming it (another run publishing, a concurrent revert). The three cases **show what is coming,
they do not promise it** — and the wording says so (`purgeCaseMayMove`).

**The server answers the fallback's version number too** (`purgeFallsBackTo`). A client could work it
out — it is a question about states — but the rule it would be writing is the server's rule for
**which versions a restore may stand on** (`newestActiveVersion`), so a change there leaves the screen
quietly stale while the client's own tests keep passing. §7.2 contemplates exactly such a change
(a retained `superseded` row must not be counted), so **the rule stays in one place** (§7.2
decision 6). It also stops depending on the
list being unpaginated (open issue 13's original note).

**The choice of wording is pinned by tests.** `resource-version-history.test.tsx` has one test per
case, and each asserts **the other branch's sentence is absent** — the choice was made wrongly three
times over four rounds and nothing failed, because no test looked at which sentence appeared.

In every case, "rows may remain in layer 2" is stated.

**If the intent is simply to roll the current content back, use a rollback (ADR-044) rather than a
purge.** The content survives and editor rights are enough (§9.4).

**Implementation status**: the layer-1 purge API handles **a single version only**, and that is
enough. As in §9.3 the unit is one version, and covering several versions is a repetition of it.
`idx_resource_version_one_purging` allows only one version to be `purging` at a time, so even a bulk
API would run serially internally and the only gain would be fewer calls. **We do not build one.**

### 9.7 Shapes considered and not taken (history)

**Fine-grained layer-2 purge** (naming a version and erasing just its rows from layer 2 as well).
It works if compaction is not run, and we took the measurements — ordering it as "step down from the
live side to N" makes each step a live purge, and the rollback's
`CREATE OR REPLACE TABLE ... AT (VERSION => the preceding version)` writes new files for the whole
content, so a file where contaminated and current rows coexisted gets its `end_snapshot` there and is
freed. The diff approach needed no extra steps either (measured: contaminated rows 0 both with and
without compaction, and time travel over v1..N-1 healthy).

**We did not take it because the ingest runs `merge_adjacent_files`** (§11-2.1). A merge pushes the
consolidated file's `begin_snapshot` back to the oldest source file, so retained snapshots older
than N keep referencing a file that contains rows from N onwards (measured: 10 contaminated rows
remain even after an ordinary purge). **Time travel stays correct for every version, so a test that
looks at content cannot notice.**

**`rewrite_data_files` is not a substitute.** Unlike a merge it does not redirect history, so it is
compatible with a fine-grained purge — but that is on a single-table catalog, and it fails for two
reasons anyway (measured, append-dominated keyed ingest, 12 versions):

- **It does not fire.** The deletion ratio per file is low (5 deletions in 120 rows), so not only the
  default 0.95 but even 0.5 produces zero candidates. Lowering it to 0.01 caught exactly one, and
  **storage grew by 24%** (7.8 → 9.7 kB). "Worse than doing nothing", as measured on the old shape,
  holds on the keyed path too
- **Even when it fires, the blocker is something else.** In the production shape (two tables), 10
  contaminated rows remained with or without a rewrite. What stops the release is **retained
  snapshots of another resource falling inside that file's lifetime** (§9.2), and per-table
  compaction does not move that
- **It is not effective as a capacity tool either.** Even expiring the entire past and then
  rewriting only goes from 820 to 788 kB (4%) (§14.1-8). But **the file count drops from 133 to 19**,
  so there may still be room for it as a tool against scan cost — bytes are +15% but scanning is
  proportional to the file count (§14.1-9)

**The same measurements showed that what decides the reach is the purge range, not compaction.** On
a single table it disappears with or without a rewrite (contaminated rows 5 → 0) — because the range
included the point where the content was replaced, exactly as "the range is N through live" of §9.3
prescribes. The §9.9 measurement in which it does not disappear is the case of naming **a single
version whose rows coexist with rows later versions hold as current**, and the two do not
contradict.

Both repairs were confirmed by measurement, but neither was put in the entry path.

- **Also expire the snapshots in the merge interval containing N.** Closing the interval with
  `max_file_size` keeps the collateral to at most K-1 versions (contaminated rows 0 in measurements).
  We do not take it because the delta size of one version differs by orders of magnitude per resource
  and **missing the window would go unnoticed**
- **Re-stream from layer 1.** This was adopted for a while as the second stage but has been
  **withdrawn** — rebuilding only writes new files, and what holds the old files is another
  resource's retained snapshots (§9.2). It is not erasure at the resource level

**Purging a single version.** For rows held by only one version, expiring that version alone removes
them from disk completely — confirmed in all four combinations of full rewrite/diff × with/without
compaction. But content existing in only one version only happens when the next version overwrote it
immediately, which does not match the default of §9.3.

**Publishing the corrected version first and erasing only N..live-1.** live can be kept, so **there
is zero data loss**. It worked in measurements too (publish v9 → purge v5..v8 → contaminated rows 0,
live intact, time travel over v1..v4 healthy). With the diff approach it additionally requires a step
to fold live into one file (`CREATE OR REPLACE TABLE t AS SELECT * FROM t`), and skipping it produces
no error while the deletion can complete incompletely (open issue §14.1-10).

**Fold live, then expire everything before it.**

**There is a way that works, but it drags in the whole catalog and the cost ultimately falls on every
resource.** It is two steps:

1. **Fold the target resource's live into one file**
   (`CREATE OR REPLACE TABLE res_x AS SELECT * FROM res_x`; `res_<uuid>` is the table name for one
   resource — `lakeTableName`). With the diff approach every file holds current rows, but folding
   makes **every file before it history-only**
2. **Expire everything before the folded snapshot, and `cleanup_all`**

Measured (two tables, 10 versions each): contaminated rows 5 → **0**, both tables' current content
intact (700 rows each).

**The write cost and the blast radius spread separately.**

|                           | Scope                        |
| ------------------------- | ---------------------------- |
| Write cost (folding live) | **Only the target resource** |
| History lost (expire)     | **The entire catalog**       |

Only the table you want to erase needs folding. Nothing is erased for the other resources, so their
current rows can stay in their existing files, and those files remain live (they get no
`end_snapshot`) and so are not subject to `cleanup`. **The cost of the erasure itself is O(the live
content of the target resource).** Folding the other resources too would free their dead bytes as
well, but that is not needed for the erasure to work.

**The price is the catalog-wide layer-2 history.** expire is catalog-wide, so **unrelated resources
also lose the ability to time travel to before that point** (measured:
`No snapshot found at version 4`). What is lost is only diffs and time travel; both layer-1 content
and layer-2 current content remain. The reconciliation of §4-4 nulls snapshot IDs that no longer
resolve and it degrades to the three-stage fallback of §7.

**And recovery starts automatically. That is where the real cost is.** Other resources' versions —
**including their live versions** — lose their snapshots (only versions published after the expire
range escape). The sweep's predicate is "`ducklake_snapshot_id` is null and there is no newer
ingested active version", so **immediately after this operation every version of every resource
matches** — the hourly sweep picks all of them up for re-ingest. Because the ingest re-evaluates
under its own lock, once one version per resource is in the rest are excluded and it converges, but
**the queue starts from every version**, and depending on which version goes in first it swings
between a minimum of "one version per resource" and a maximum of "the entire history". **In other
words a rebuild of every resource has not been avoided — it has merely been automated and
deferred.** If you do run it, stop the sweep first and decide the recovery order by hand.

**Even so, we do not offer it as a product feature.** An operation that drops every resource's
history at the request of one resource is not made pressable from a screen. **We record only that
the procedure exists, as an operational escalation.**

### 9.8 Derivatives and backups

**The preview Parquet (layer 3) is not held per version.** There is a single
`resource_pipeline.preview_key` and it always represents live's content. Each run writes to a new
key and **the previous key is parked in `orphaned_object`** (`PARKED_UNTIL` = 1 hour, cleaned by the
sweep). Step 3 of §9.1 parks the current key and **`deleteMany`s it on the spot** — parking is
insurance, not the mechanism. The preview Parquet is the output of a standalone
`COPY … (FORMAT parquet)` and **has no delete vector** (it is not a DuckLake table), so deleting the
object deletes the rows.

**The remaining window**: a preview created by an intermediate version between N and live may already
have been parked, replaced by a later run, and the purge does not hurry it along. For up to one hour
plus the sweep interval, a preview containing contaminated rows can remain in storage. The right fix
is **an immediate sweep of that resource's parked objects at purge time** (open issue §14.1-7).
Layer 3 has no delete vector, so unlike layer 2 this one can be removed.

The physical-disappearance timeline (S3 noncurrent 30 days, ADR-037) is the same as Phase i. **It is
not coupled to the PG backup retention period** — layer-1 version file deletion is already like
that, and keeping purged bytes alive "so that references do not break no matter which backup they are
restored from" runs against the purpose of a purge. A snapshot that loses its referent after a
restore is nulled by the reconciliation of §4-4 and degrades through the three-stage fallback (a
degradation of the diff feature, not data loss).

### 9.9 Properties confirmed on real machines

`packages/lake/src/__tests__/purge.ducklake.test.ts` (DuckDB 1.5.4 / ducklake `d318a545`).

- expire can target **exactly one named snapshot** (the explicit-list form works)
- 🔴 **With a keyed ingest, a purge frees fewer bytes than the original measurements suggested.** Of
  the 50 rows version 2 wrote, later versions hold 25 as current. The other 25 are referenced by
  nothing, but **they are not freed because they live in the same file as the current rows**
  (measured 50 → 50). Rows a later version deleted behave the same: they can no longer be read from
  the table but remain in the file (measured 1 → 1, 0 from live). **The container principle of
  ADR-043 §5.1 applies without exception in ii-b.**

  This was originally recorded as "the target rows physically disappear from the Parquet" because
  **the test used `WHEN MATCHED THEN UPDATE` without a predicate**. That form rewrites every matched
  row so whole files are replaced, the old file gets its `end_snapshot`, and the history is freed
  with it. **This does not happen in the adopted form (with a value predicate).** Measuring a
  different shape than you ship makes you overestimate the reach of §9 — today both the tests and the
  benchmarks take their SQL from the single place `src/keyed-load.ts`

- **After running `merge_adjacent_files` a fine-grained purge no longer works** (10 contaminated rows
  remain). With `rewrite_data_files` inserted in the same shape it does work (0 contaminated rows,
  matching content digests over 220 retained versions). The difference is whether the history is
  redirected; the mechanism is in §11-2.3
- **Dropping the table and rebuilding from layer 1 did erase them** (39 contaminated rows → 0, live
  intact), but **that measurement had only one table in the catalog**. In the production layout (one
  table per resource, catalog shared), other resources' retained snapshots keep holding the old
  files, so it does not work (§9.2)
- **Rows behind the delete vector left by a plain `DELETE` are not freed even by expiring that
  version.** As long as live holds other rows in the same file, expiring all the history beneath it
  frees nothing. **Our ingest paths (`MERGE` and `CREATE OR REPLACE`) do not create this shape**, so
  there is no practical harm, but adding a partial-update statement could
- **`cleanup_all => true` cannot be omitted.** Files that lost their references merely get listed in
  `ducklake_files_scheduled_for_deletion`, and the default `cleanup_old_files` **deletes nothing**.
  expire is the operation that marks things "safe to delete", not a deletion
- Uploading a corrected version after a purge (§9.6 step 3) does not bring the erased rows back
- Expired snapshot IDs are **not reused** (new IDs are assigned)
- If a fine-grained purge is adopted, **expiring only the named snapshot without re-deriving the
  retained set from the version rows leaves rows behind** (it shows up from three versions onwards —
  with two versions the rollback doubles as the newest snapshot and it happens to work)
- `rewrite_data_files` **consolidates the several files it rewrites into one**. At the default
  threshold (0.95) it does nothing (§11-2.1)

## 10. Sandbox Isolation (ADR-032 unchanged)

| Path                                     | Where the SQL comes from                                                        | DuckLake access                             |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| The diff API (new)                       | **Only fixed queries assembled by the server** (parameters are version numbers) | Yes                                         |
| `/query` and `query_resource` (existing) | Raw SQL from users/AI                                                           | **No** (materialize → lock down, as before) |

User SQL is never allowed to touch the DuckLake catalog or data files. Extending the existing query
path is limited to "materialize that version's Parquet via a `version` parameter" (the sandbox design
does not change).

## 11. Operations

### 11-1 Data inlining is disabled

**Data inlining is disabled** (`data_inlining_row_limit = 0`, persisted in the catalog). By default
small writes go into the catalog rather than into Parquet. Since each row has a lifetime
(`begin_snapshot` / `end_snapshot`) it ought in principle to be reclaimable, but **expire does not
reclaim inlined rows** (ADR-043 §6-1). Measured: even after expiring a version, inlined rows whose
`end_snapshot` is closed remain in the catalog — **unreachable from anywhere and not gone either**.

**`ducklake_flush_inlined_data` is not the answer. It works the other way.** In measurements it
**writes out even the rows of already-expired versions to storage** (it Parquet-ifies the whole
history, so expired versions come back as objects). Reversing the order does not help: flushing first
puts every version into files that surviving versions reference, so expire cannot free them.
**Inlined rows have no reclamation path other than "delete the file", and the one call that can turn
them into files undoes the deletion.** Indeed, none of the maintenance functions the extension
exposes reclaims inlined rows (`expire_snapshots` / `cleanup_old_files` / `delete_orphaned_files` /
`merge_adjacent_files` / `rewrite_data_files` / `flush_inlined_data` only).

Upstream, [ducklake#1067](https://github.com/duckdb/ducklake/issues/1067) raises the same request (we
want `ducklake_cleanup_old_inlined_data`) and was closed as fixed by
[#1145](https://github.com/duckdb/ducklake/pull/1145).
**But what #1145 removes are orphaned inlined _tables_, not closed _rows_ inside a live table** (the
fix for #1065 / #1088). The reporter themselves asked "just the table, or the data inside too?" with
no answer, and measurements on a build after #1145 (`d318a545`) still show the rows remaining. This
can be revisited once upstream implements row reclamation.

**The decision does not change in ii-b either.** A keyed `MERGE` does not create "small files
containing only the changed rows" (see 2 below). A small table is **re-inlined in its entirety per
version** and a large one is rewritten wholesale into Parquet — the economics of inlining do not move
with the presence of a key.

The setting **only affects subsequent writes**. If a catalog created before this change still has
inlined rows, they remain without a reclamation path. In such environments, discard the lake tables
and re-ingest from layer 1 (the "delete all data" action in the admin screen, or dropping the
`ducklake` schema + migrating). ii-a's ingest was introduced around the same time as this change, so
normally only leftovers in development environments are affected.

### 11-2 Compaction — nothing happens in ii-a

**Compaction "has nothing to do" in ii-a. Not because it is harmful.** Because every row is
replaced, there is no fragmentation, and there are no deletes either, so both
`merge_adjacent_files` and `rewrite_data_files` return zero candidates (`[]`) (measured). A diff
always reads only two files (v1→v20 costs the same as v19→v20). **Running it has no side effects; it
simply does nothing.**

**Consolidated files do not grow as versions accumulate.** Replacing all rows across 60 versions and
calling merge every version left live at 1, the largest file unmoved at 0.18 MB, and **consumed not a
single snapshot** (measured). Total capacity grows linearly with the version count (0.175 MB per
version), but that is history retention, not a compaction matter.

**"live is always 1" is not accurate** — `INSERT` splits files at `target_file_size`, so a table
larger than that produces several files even in one version (measured: lowering target to 256kb gave
2 files in one version). **Even then merge does not fire.** Varying `max_file_size` up to 1 GB, and
`min_file_size` and `max_compacted_files`, still gave zero candidates. **The exact predicate has not
been identified**, but the conclusion that calling merge in ii-a does nothing holds on the side where
the table exceeds `target_file_size` too.

Conversely, **there is no need to exclude ii-a from the end of the ingest with a special case**. Do
not dispatch on whether there is a key; put the same single line in every resource's ingest. Even if
ii-a and ii-b tables coexist during the transition, even if the key setting is removed, even if key
validation fails and the version does not enter layer 2, the caller need know nothing.

**In ii-b we take the diff approach, so live files grow per version** (§11-2.4). Storage shrinks by
two orders of magnitude, but a full scan grows roughly linearly with the version count (+0.49 ms per
version cold, +0.05 ms warm), so **at the end of an ingest, if the live file count is over the
threshold, run `merge_adjacent_files`** (§11-2.1). `rewrite_data_files` is not used — on
append-dominated data it has little effect and actually increases storage (§11-2.3). **A merge
redirects layer-2 history, so purges presuppose the two-stage structure of §9.**

**This is not "DuckLake tidies up as needed".** ii-a does not fragment because the ingest replaces
the whole table with `DELETE` + `INSERT` (`ingest.ts`), and **there is no automatic compaction firing
on a threshold** — `DuckLakeTransactionManager` overrides only `StartTransaction` /
`CommitTransaction` / `RollbackTransaction` / `Checkpoint`, and in measurements DETACH + re-ATTACH
and closing + reopening the connection both left the fragmentation in place.

**It collapses the moment a partial-update statement is mixed in.** A plain `UPDATE` adds one live
file per statement and accumulates **linearly and without bound** (measured: 40 statements gave 41
live files, 81 on disk).

### 11-2.1 Compact at the end of an ingest (`MERGE_FILE_THRESHOLD`)

**At the end of an ingest, if live files number `MERGE_FILE_THRESHOLD` or more, run
`merge_adjacent_files`.** There were no candidates in ii-a, but it takes effect with ii-b's diff
approach. Because it lives in the ingest job rather than on a schedule, **neither a choice of period
nor a separate periodic job is needed.**

**The threshold is expressed as a file count.** Scan cost is roughly linear in the file count
(measured at about 0.03 ms per file on a local FS), so `file_count >= T` writes the goal — "keep the
number of files a scan reads at or below T" — directly. Unlike a period K (whose right value differs
per resource) or `target_file_size` (which requires estimating bytes), **T depends on neither size nor
update frequency**. It is read from the catalog every time, so it cannot drift.

**The default is `MERGE_FILE_THRESHOLD = 50`, made a runtime setting per ADR-036** (§14.1-2). There
are two reasons to move it — the reader's parallelism, and **that resource's floor** (the live file
count below which nothing more can be folded). **Any firing with T below the floor is a miss**, so if
you are going to move it, measure the floor first.

Those are the decisions. What follows is the reasoning, and you can implement without reading it.

#### The reasoning for 11-2.1 (measured)

**The measurements use the adopted write path** — two predicated `MERGE` statements in one
transaction (`src/keyed-load.ts`). The earlier numbers were taken with two statements, `INSERT` +
`UPDATE` (two snapshots per version, and without predicates it rewrites whole files), **a path
§11-2.4 decided against**. Change the shape of the writes and the growth of live files changes, and
the meaning of the threshold with it.

**All table scans are measured with `threads` at its default = the core count** (24 for the MinIO
rows, 16 and 2 for the S3 rows). **Production does not use that default** — `QUERY_THREADS` /
`LAKE_INGEST_THREADS` pin it to 2, so the MinIO rows sit on the more parallel side than production.
The only rows whose conditions match are the S3 · 2 vCPU ones.

**cold and warm are measured separately.** DuckDB's file cache is per instance, so a scan differs by
an order of magnitude between "the first time in a new process" and "the second time onwards in the
same process". **Neither is an exceptional case** — ii-b adds one file per version, so a new
version's file is cold for every process at first. Measured (MinIO, 24 cores):

| T      | merge count | merge total | worst live | cold scan | warm scan |
| ------ | ----------: | ----------: | ---------: | --------: | --------: |
| none   |           0 |        0.0s |        401 |  251.0 ms |   31.4 ms |
| 25     |         131 |       11.0s |     **42** |      45.8 |      13.6 |
| **50** |      **74** |    **6.1s** |     **57** |  **50.5** |  **13.2** |
| 75     |          22 |        2.0s |         75 |      57.2 |      14.9 |
| 100    |          14 |        1.2s |        100 |      69.2 |      16.8 |

**T=25 is below the floor.** It fires 131 times and live only comes down to 42 — a consolidated file
carrying deletes is not a merge candidate (§11-2.3), so nothing beyond that can be folded. **It keeps
firing where there is nothing left to lower.** A keyed ingest creates a delete file per version, so
consolidated files quickly drop out of candidacy.

**We therefore raise the default from 25 to 50.** Merges fall 44% (131 → 74, 11.0 → 6.1s), cold grows
10% (45.8 → 50.5 ms) and **warm shows no difference** (13.6 → 13.2 ms — inverted, i.e. noise). T=25's
advantage exists only cold, and that cold measurement varied across three runs at 43.1 / 45.8 /
93.6 ms — **a single cold scan has 2× variance**, so we do not stake the default on that gap. What is
decisive is the merge count and the live count, and neither varies.

**The floor is fixture-dependent, and that is why T is a runtime setting.** The floor's position is
set by how fast rows turn over, so it differs per resource. **Any firing with T below the floor is a
miss**, so measure the floor first and put T a little above it.

The S3 numbers were only taken warm, and with **the old write path** (the measurement environment has
since been dismantled). Cold was 12× warm at 401 files, so the table below is optimistic throughout.
**Only the unit cost (the slope) carries over**; the absolute values per T differ under the adopted
shape:

| Environment (warm)      | Scan cost per file | Worst scan at T=25 | Worst scan at T=100 |
| ----------------------- | -----------------: | -----------------: | ------------------: |
| MinIO (loopback)        |      0.049 ms/file |             9.4 ms |             13.4 ms |
| S3 · 16 vCPU (same VPC) |       0.32 ms/file |            53.4 ms |             57.6 ms |
| S3 · 2 vCPU (same VPC)  |   **3.11 ms/file** |           152.5 ms |        **339.9 ms** |

**What sets the unit cost is not storage latency but having enough parallelism to hide it.** Going
from 2 to 16 vCPU cut the slope by a factor of 9.7. That 16 vCPU in the same VPC (0.32 ms/file) and a
many-core machine over the internet (0.36 ms/file) came out nearly identical shows that core count
matters more than path length.

**But what actually matters is not the core count itself, it is the thread count — and that is
configurable.** DuckDB's scan uses a morsel-driven thread pool, not asynchronous I/O — the number of
range requests it can have in flight is exactly the thread count, and the default merely happens to
be the core count. Sweeping a cold scan with `SET threads` **plateaued at 8 threads regardless of
core count** (401 files):

| Threads | MinIO · 24 cores | S3 · 2 vCPU |
| ------: | ---------------: | ----------: |
|       1 |         998.3 ms |  29004.6 ms |
|       2 |            502.5 |     15078.8 |
|       4 |            276.7 |      8101.9 |
|   **8** |        **186.6** |  **6153.2** |
|      16 |        **172.4** |      6203.0 |
|      32 |            193.8 |      6067.5 |
|     128 |                — |      6926.8 |

The MinIO column was re-measured under the adopted shape. The S3 column is still the old shape (the
measurement environment has been dismantled), but **the shape of the curve is the same** and only the
file-count-derived absolute values change.

**"Threads beyond the core count are pure switching cost" turned out not to hold.** Scanning is
latency-bound, not CPU-bound, so even on 2 vCPU going from 2 to 8 threads is 2.45× faster. The
degradation past the plateau is small (flat to 32 threads on 24 cores; 128 threads is 14% worse than
32 on 2 vCPU) and **the gain is an order of magnitude larger**.

**The cause of the plateau has not been identified, but it is not the core count.** Stopping at 8
happened on 2 cores and on 24 alike. Nor is it a residual serial fraction (`S + P/n`) — fitting from
n=1 and 4 predicts 83 ms at n=16 against a measured 155 ms, so it is a ceiling rather than
saturation. It is not a per-query ceiling either: running the same scan 1 / 2 / 4 at a time gives
total throughput of only 5.1 → 6.5 → 7.1 /s, so **a single scan is already nearly saturated**. There
was no plausible read-side ceiling setting in `duckdb_settings()`.

**Re-establishing connections does inflate the unit cost, though.** `httpfs_connection_caching`
defaults to **false**, and enabling it cut the TCP connections per scan by a factor of **24** (140 →
6 by the TIME_WAIT delta) and made cold scans 1.4–1.75× faster (150 → 88 ms on MinIO with 401 files
and 16 threads). It does not move the plateau, so it is not the ceiling itself, but it does affect
the unit cost (§14.1-2). `enable_http_metadata_cache` and `prefetch_all_parquet_files` made no
difference.

**So "T is decided by the reader's vCPU allocation" is not accurate.** What decides it is the thread
count, and a 2 vCPU reader can recover most of that 3.11 ms/file with `SET threads`. **Today
`QUERY_THREADS` and `LAKE_INGEST_THREADS` are both 2, the worst point in everything measured**
(§14.1-2).

**T and `threads` cannot be decided independently.** The lower the parallelism, the more the
threshold matters (MinIO, cold):

| threads | T=25     | T=100     | 401 files | T=100 / T=25 |
| ------: | -------- | --------- | --------- | -----------: |
|       1 | 74.7 ms  | 226.1 ms  | 796.8 ms  |         3.03 |
|   **2** | **48.1** | **125.1** | **403.1** |     **2.60** |
|       4 | 33.9     | 74.3      | 225.9     |         2.19 |
|       8 | 32.9     | 56.6      | 153.3     |         1.72 |
|      16 | 35.7     | 59.2      | 155.3     |         1.66 |
|      32 | 35.4     | 57.8      | 154.0     |         1.63 |

**At production's threads=2, T=100 is 2.60× T=25**, the smallest room there is for raising T. Raising
threads to 8 shrinks it to 1.72×, so **threads is what should be moved first** — it does more than
raising T (48.1 → 32.9 ms at the same T=25) and, unlike T, it costs no extra merges. When T is moved
as a runtime setting, re-measure it together with the `threads` value in force at the time.

**Raising T costs reads; lowering it costs writes.** Over 200 versions, merges are 74 times / 6.1s at
T=50 and 14 times / 1.2s at T=100. Going 50 → 100 divides the writes by five but takes cold from 50.5
to 69.2 ms (+37%). **50 is not the worst on either side.**

**Merge seconds and scan milliseconds must not be compared on the same footing.** A merge happens
once per published version, while a scan happens **every time it is read**. Raising T saves a few
milliseconds per publication and can lose tens to hundreds of milliseconds per read.

**Comparing absolute values across environments requires matching both the core count and
cold/warm.** The local FS (0.030 ms/file, warm) and MinIO (0.049 ms/file, warm) are on the same
machine and can be compared, but lining EC2 numbers up beside them is wrong.

**The floor shows up in the table above too.** Worst live at T=25 is 42 files, which never comes down
to the threshold. In the old measurements too, taking T to 10 or below left live stuck at 11 files
(360 versions). A consolidated file carrying deletes is not a merge candidate (§11-2.3), so nothing
beyond that can be folded. **Any firing with T below the floor is a miss.**

**The value of compaction comes from files being small, not from their number.** On a wide table
(400,000 rows × 256B = 110 MB, 100 versions) compaction barely matters:

| T    | Firings | merge total |          Worst scan |
| ---- | ------: | ----------: | ------------------: |
| none |       0 |        0.0s | 201 files / 45.5 ms |
| 1    |     100 |        8.4s |   2 files / 42.5 ms |
| 100  |       2 |        0.2s | 100 files / 41.7 ms |

The scan is dominated by reading 110 MB and the file count is noise (550 KB per file). The 55.5 →
7.5 ms difference on the light table appears because each file is only 1.5 KB — **fragmentation is
only a problem when things are chopped small**. It is not that bigger tables need more compaction;
the opposite. Taking T on the larger side also avoids merge working excessively on big tables.

**Only the absolute values fail to carry over; the shape does** (scans linear in the file count, a
floor exists, bytes dominate for large files). Only the following two constants change, so measuring
them per environment lets you compute T:

```
scan ≈ file count × unit cost + bytes / throughput
one merge ≈ min(table, target_file_size) / throughput
```

**T is therefore a runtime setting per ADR-036, with the default measured per environment**
(§14.1-2).

**Re-measure with `pnpm bench:lake`** (`packages/lake/scripts/bench-compaction.ts`). It is the same
harness that produced the tables above, and passing `--data s3://…` runs the same measurements
against MinIO / S3. A constant with no way to re-derive it is a constant nobody can revisit.

**Build time does not depend on table size.** Sweeping the base at 20,000 / 200,000 / 2,000,000 rows,
building with a merge every version (no threshold) took 45.8 / 44.5 / 45.7 seconds and did not move
(200 versions). The difference against periodic execution is consistently a fixed cost of about 75 ms
per merge, and a term proportional to data volume does not surface in this range (up to 18 MB on
disk).

**This is a setting that goes against DuckLake's default, and there is a reason we may.** How much
one merge writes is set by `target_file_size` (default `1 << 29` = 512 MiB,
`ducklake_catalog.hpp`):

| Table                    | How much one merge writes                                                  |
| ------------------------ | -------------------------------------------------------------------------- |
| Far below target         | The whole table (18 MB for us, so 75 ms)                                   |
| About the same as target | **The whole table** (400 MB every version if it is 400 MB) ★ pathological  |
| Far above target         | Only the remainder — files that reach it drop out of candidacy permanently |

At the default, the pathological band covers the whole 0–512 MiB range, and most small and mid-sized
tables fall in it. **That is why DuckLake cannot make "merge on every commit" the default**, and we
get away with it because we sit at the bottom of the band. It also matters that our commit frequency
is per published version (a few times a day); in a lake with hundreds of commits per second the 75 ms
fixed cost would not be negligible either. On top of that, a merge is a destructive operation in
which `WriteMergeAdjacent` `DELETE`s the source files' catalog rows, and external Parquet registered
with `ducklake_add_data_files` can be affected too — not the sort of thing that can be a side effect
of a commit. Indeed DuckLake provides maintenance as an explicit `CHECKPOINT <catalog>` operation
(§11-2.2).

**`target_file_size` affects ordinary writes too** (`file_size_bytes = MaxValue(target_file_size,
MINIMUM_WRITE_FILE_SIZE)` in `ducklake_insert.cpp`), so lowering it makes the generated Parquet
smaller as well. If a resource whose layer 2 reaches hundreds of MB appears, lower it to bound the
amount written per operation (§14.1-2). **The default already matches our design**, so there is no
reason to set it now.

**The trigger for revisiting is version frequency.** Write amplification is
`commit count × min(table size, target)`, so what bites is the frequency in the denominator: with
commits at minute or second intervals as in high-frequency ETL, even the 75 ms fixed cost becomes a
throughput ceiling. This decision assumes "a version = a data publication, a few times a day".
**Scheduled fetching of external URLs is a path inside the product that could break that assumption**
— if the content of a resource configured with a short period changes every time, versions pile up
every few minutes. If such a resource appears, drop just that one to periodic execution or lower
`target_file_size` (§14.1-2).

**The other cost is snapshot count**, consuming one per merge (measured: 722 → 1082). What version
rows name are the ingest-side snapshots; a merge's snapshots are referenced by no version row — a
shape the expiry-candidate computation of §11-3 (all snapshots − IDs referenced by version rows − the
newest) handles as-is.

**`rewrite_data_files` is not used.** Measured in the same shape, append files carry no deletes at
all so they never become candidates (`total_delete_count == 0 ||` in `GetFilesForCompaction` applies
before the threshold check), and it merely duplicates the base files that carry corrections:

| Compaction (1200 versions) |   live |   Capacity |   Full scan |
| -------------------------- | -----: | ---------: | ----------: |
| none                       |  2,401 |     4.1 MB |     97.6 ms |
| `rewrite_data_files(0)`    |  1,816 | **6.8 MB** |     63.8 ms |
| `merge_adjacent_files`     | **83** |     3.4 MB | **11.3 ms** |

**It uses more storage than doing nothing.** Raising the threshold does not fix it — at 0.5 or at
0.95, no candidates appear at the update frequency of government data (measured: 300 versions with 5
rows changed each, live 298 → still 298 at 0.95, and 245 at 0.5). The threshold is "the fraction of
rows deleted since that file was written", and in the diff approach **a file = a version**, so it
measures "how much of that version's change has been overwritten". It is rare for 95% of government
data to turn over.

**A merge reduces the file count, not the capacity.** The breakdown (360 versions, decomposed into
column chunks and the rest with `parquet_metadata`):

| Compaction | Total   | Column chunks | Footers etc. | Raw data |
| ---------- | ------- | ------------: | -----------: | -------: |
| none       | 1.24 MB |       0.94 MB |      0.30 MB |  2.09 MB |
| merge/100  | 1.14 MB |       1.07 MB |      0.07 MB |  2.53 MB |

The fixed cost of footers and the like drops from 0.30 to 0.07 MB, while consolidated files represent
every generation's rows in one file so the raw data grows. **It roughly cancels out, and the value is
in scan time.**

**Introducing a retained generation count for versions** (§14.1-8) would expire old snapshots and
free the delta files too, giving consolidation its proper meaning. Until then, compaction is treated
as **spending to buy reads**.

**Breakdown of the file count** (measured: 20 versions, 20,000 rows → 59 files on disk):

| Kind         | Count | Breakdown                                                      |
| ------------ | ----: | -------------------------------------------------------------- |
| Data files   |    21 | 1 base + 20 per-version deltas                                 |
| Delete files |    38 | **About 2 per version** — because the ingest is two statements |

Two delete files per version is a side effect of the workaround for the one-action constraint on
`when_matched` (upsert and prune each leave a tombstone). The byte count is dominated by the base so
it does not affect capacity, but **the object count grows by about 3 per version**. **These are not
orphans** — in measurements `ducklake_delete_orphaned_files` returns 0. Orphans are only files the
catalog does not record, and all of these are recorded and referenced.

**One of the two per version can be recovered, though.** If the one-action constraint is lifted and
the ingest can go back to a single statement, tombstones halve. The relevant case in
`merge.ducklake.test.ts` carries that signal.

**`file_count` is not the total on disk but "the number alive in the current snapshot".** Each file
has a `[begin, end)` lifetime and a read resolves only to files covering the requested snapshot
(measured: 2 at snapshot 2, 10 at 11, 20 at 21). **Old snapshots are retained because diffs and time
travel read them** (`lake-reclaim.ts`), and expiring them degrades the very features ADR-043 is
building.

### 11-2.2 `CHECKPOINT` must not be run

**`CHECKPOINT` must not be run against the lake catalog.** `CHECKPOINT <catalog>` enters
`DuckLakeTransactionManager::Checkpoint` (`src/storage/ducklake_checkpoint.cpp`) and runs six
maintenance functions in a fixed order:

```
flush_inlined_data → expire_snapshots → merge_adjacent_files
→ rewrite_data_files → cleanup_old_files → delete_orphaned_files
```

Three of the six are ones whose conditions we should be choosing ourselves. **It calls
`expire_snapshots` with no arguments** — our expiry candidates are an explicit list re-derived from
the version rows (§11-3), and if `expire_older_than` is configured it would run on a time basis. **It
calls `flush_inlined_data`** — in environments with inlined rows left over, that writes expired
versions out to storage (§11-1). **It calls `delete_orphaned_files` with the default window** — we
close the room to read a file being written as an orphan by using a wider window (§11-5).

The two compaction functions themselves do not break purges (see the end of §11-2.4), but there is no
reason to run them in a form that drags the other three along. `CHECKPOINT` without arguments only
affects the default catalog and does not reach lake (measured), but do not write it in a form that
does.

### 11-2.3 The division of labor between `merge_adjacent_files` and `rewrite_data_files`

**The division between `merge_adjacent_files` and `rewrite_data_files` is decided by "does it carry
deletes".** Not by scale and not by how things accumulate
(`src/functions/ducklake_compaction_functions.cpp`).

- `merge_adjacent_files` **does not handle files with deletes**
  (`merge_adjacent_files should not be used to rewrite files with deletes`).
  It stacks small files up to `target_file_size` (default `1 << 29` = 512 MiB,
  `ducklake_catalog.hpp`) and cuts them into one, skipping files that exceed the threshold on their
  own. Measured: 40 small files without deletes → 1
- `rewrite_data_files` handles files with deletes, rewriting those past `delete_threshold`
  (default 0.95, setting name `rewrite_delete_threshold`). It is the only one that can remove delete
  files

  ii-b runs only `merge_adjacent_files` (§11-2.1).

**What separates the two is "can the replacement answer the same questions as the original".**

A merge selects only files without deletes whose row_ids are adjacent, so the consolidated result is
**the same row set** as the source files. A per-row `snapshot_id` column is written into the
consolidated file (`write_snapshot_id`), and the catalog's `partial_max` plus `SetSnapshotFilter`
hide later rows from older versions. **One file can reproduce the view of every generation**, so the
source files are considered redundant and `WriteMergeAdjacent` **`DELETE`s their catalog rows**
(rather than closing them with an `end_snapshot`). The consolidated file's `begin_snapshot` reaches
back to the oldest source file precisely to fill that hole.

A rewrite materializes the deletes, so its output is not the same row set as the source and cannot
stand in for older snapshots. `WriteDeleteRewrites` therefore closes the source data and delete files
with an `end_snapshot` and **keeps** them, giving the new file a `begin_snapshot` as of the rewrite.
**It does not redirect history.**

**This difference is what gives purges the shape of §9.** Once merges are run, retained snapshots
older than N keep referencing a consolidated file that contains rows from N onwards, so **it is
impossible to erase only a particular version's rows from layer 2** (measured: merge every 4
versions, contamination in the middle of an interval — 10 contaminated rows remain even after a
fine-grained purge). Looking at the catalog, later merges swallow earlier consolidated files so
`begin` always falls back to the start of history:

```
default                  #9[2..) → #18[2..) → #27[2..)     rebuilt in full every time
max_file_size explicit   #9[2..)  #18[7..)   #27[12..)     independent per interval
```

**Time travel stays correct for every version, so what breaks is only the granularity of erasure, and
a test that looks at content cannot notice.** Hence the purge of §9 **claims unfetchability and does
not guarantee erasure of layer-2 bytes**.

**The idea of running `rewrite_data_files` instead was not adopted.** It does not redirect history so
a fine-grained purge works (measured: 300 versions, rewrite every 50, contamination at version 220 →
contaminated rows 39 → 0, with matching content digests over 220 retained versions), but **it does
not work on append-dominated data** (the table in §11-2.1). A file with no deletes at all is out of
candidacy regardless of the threshold, and an appended version is exactly that. It was effective only
on synthetic data where rows are reused frequently (1000 versions, 2000 rows: live 358 → 8, scan 24.5
→ 6.6 ms, storage +10%).

**Closing merge intervals with `max_file_size` was not adopted either.** Setting it so that
"one version's delta < max ≤ the consolidation of K versions" keeps the `begin` reach within one
interval and limits collateral to at most K-1 versions (measurements brought contaminated rows to 0).
We do not take it because one version's delta size differs by orders of magnitude per resource, and
**missing the window would go unnoticed**.

### 11-2.4 We take diffs, not full rewrites

**Full rewrite or diff is something we choose with a predicate. We take the diff — storage differs by
two orders of magnitude.**

`WHEN MATCHED THEN UPDATE` has no predicate, so it updates **every matched row** and rows whose
values are identical count as updates. The result is that whole files get rewritten. With
`WHEN MATCHED AND t.c IS DISTINCT FROM s.c THEN UPDATE` only rows that actually changed are touched,
producing a delta file plus a delete file. The behavior of `MERGE` and `UPDATE` is **identical**, and
what decides the write path is only "how many rows that statement updates" (exactly as explained in
[#462](https://github.com/duckdb/ducklake/issues/462); we initially saw this as a DuckLake defect and
reported #1388, then withdrew it because the comparison was unfair).

Measured (100,000 rows, 5 rows changed per version):

| Versions | Approach     | live | Deletes | Total bytes | Full scan | Point lookup |
| -------: | ------------ | ---: | ------: | ----------: | --------: | -----------: |
|       30 | full rewrite |    1 |       0 |     38.1 MB |    6.4 ms |      5.15 ms |
|       30 | diff         |   30 |      29 |     0.93 MB |    8.0 ms |      6.59 ms |
|      100 | full rewrite |    1 |       0 |      125 MB |    6.1 ms |      5.89 ms |
|      100 | diff         |  100 |      99 |     1.24 MB |   11.2 ms |      6.53 ms |
|      300 | full rewrite |    1 |       0 |      374 MB |    6.1 ms |      5.64 ms |
|      300 | diff         |  300 |     299 |     2.89 MB |   18.7 ms |      6.69 ms |

- **Storage overwhelmingly favors the diff** (130× at 300 versions). A full rewrite copies the whole
  table every version
- **Full scans grow roughly linearly with the version count for the diff** (+0.04 ms per version).
  That is per-file overhead rather than bytes; the diff actually reads fewer bytes
- **Point lookups barely move** (statistics prune the files)

**The conclusion does not change on append-dominated data either** (base 20,000 rows, +200 rows
appended and 5 rows corrected per version, 360 versions):

| Approach             | live |       Bytes |  Full scan |
| -------------------- | ---: | ----------: | ---------: |
| Full rewrite         |    2 |  **255 MB** |     6.1 ms |
| Diff (no compaction) |  721 |     1.24 MB |    28.7 ms |
| **Diff + merge**     |   11 | **0.81 MB** | **6.0 ms** |

**Read performance is the same for a full rewrite and diff + merge; only capacity differs** (315×).
On append-dominated data a per-version file holds `base + v × appended` rows, so the cumulative total
of a full rewrite grows with the square of the version count.

**What is small is the data files, not the delete vectors.** The breakdown after merging at 200
versions (measured):

| Kind                      | Count |    Total | Per file |
| ------------------------- | ----: | -------: | -------: |
| Data files                |   133 | 674.1 kB |  5.07 kB |
| Delete files              |   132 | 145.1 kB |  1.10 kB |
| (Reference) all rows in 1 |     1 | 525.4 kB |        — |

**200 versions of history fit in 1.56× a single copy of the table.** What makes this work is that one
version writes only about 205 rows (200 appended + 5 corrected); a full rewrite would copy 525 kB
every version.

**Delete vectors are the least efficient part of layer 2.** Of the 1.10 kB per file, the content is
only position information for 5 rows and the rest is Parquet's fixed footer cost. And because
**`merge_adjacent_files` only folds data files**, delete files keep growing by one per version (the
133 against 132 in the table above is exactly that). At the current scale it is only 18%, but keep in
mind that it is **the side that does not get folded**.

**With a full rewrite, versions do not share files.** Each version's file is exactly one snapshot
wide, `[v, v+1)`, so neither merges nor the `begin_snapshot` discussion arises. **We do not take it,
because that would be bought with 315× the storage.**

**Even then, erasure in layer 2 cannot be guaranteed.** Even when versions do not share files,
snapshots are catalog-wide, so **if another resource's retained snapshot falls inside `[v, v+1)` that
file is not freed** (§9.2). What a full rewrite solves is versions sharing files, not resources
sharing them. The non-guarantee in §9 is independent of the choice of write form.

**With diffs, one file is referenced by several versions, and the rows we want to erase coexist with
rows that are current in live.** From a measured catalog:

```
#13[8..)x15   ← the file v7 wrote. 10 contaminated rows + 5 unrelated ones
```

Those 5 rows are current, so no `end_snapshot` is attached and expiring that version does not free
it. **This in itself is not a DuckLake defect** — v6's content depends on v5's file, so silently
freeing it would break v6. Not freeing it is correct. The conditions under which a fine-grained purge
works, and why we did not take it, are in §9.7.

**There are two other paths by which old snapshots expire, and neither loses content.**
`standLakeTableOn` (rollback and reconciliation) replaces the recorded snapshot so the old ID
expires, but the rollback has written new files for the whole content. Reconciliation (§4-4) merely
nulls snapshots that do not resolve, degrading the diff feature.

**Once §7.2 lands, the former disappears.** Version rows' IDs are not rewritten, so old IDs do not
expire and the expiry candidates become only "those named by no surviving version" — the newest
snapshot on which a purge's step-down landed is the one regular member of that set, and the rule
above always keeps it.

**Introducing a retained generation count for versions (§14.1-8) changes the story.** Surviving
versions' snapshots become expirable, and only then does the state arise where "content outside the
retained generations exists only in a consolidated file". If it is implemented, decide it in line
with the range over which layer 2 can be recovered from layer 1 — the retained generation count also
defines layer 2's recoverable range.

A note on scale: the output of a full rewrite is bulkier than `CREATE TABLE AS` (842 KB → 1.24 MB for
the same 100,000 rows, flat thereafter). It is a one-off increment that does not accumulate, but it
bites as versions × table size.

### 11-3 Expiring snapshots

**Snapshot expiry**:

- **The explicit-list form** (`versions => [candidates]`). Candidates = all snapshots − the IDs
  referenced by **version rows that have not been purged** − the newest snapshot. **The criterion is
  not "is it current" but "has it been purged"** — a diff resolves the versions at both ends into
  snapshots to read them, so dropping a non-current version breaks comparisons against it
  (`lake-reclaim.ts` takes everything that is not `purged` / `purging`; once §7.2 lands that is just
  `active`).
  The newest snapshot is always kept because, right after a purge steps a table down, the newest
  snapshot referenced by no version row is the current content.

  `ducklake_expire_snapshots` accepts three things — `versions` / `older_than` / `dry_run` — and the
  first two are mutually exclusive. **There is no argument for "expire everything newer than N"**, so
  a range can only be expanded into a list.

- **The time-based `older_than` is not used. But it is the retention axis this format actually
  provides.** Since snapshots are catalog-wide, the only axis that carries meaning is global time
  (§9.2). The explicit-list `versions` form amounts to **making a model that only has a timeline
  express per-resource retention**.

  We still do not take it, because our policy is "keep every generation". `older_than` **drags in
  resources that have stopped being updated** — the snapshot of a version untouched for a year is
  old, yet that version may be the current one, and cutting it leaves the content intact while
  losing diffs and time travel. As long as the policy is "keep everything", **time is not an
  indicator of necessity**. The only correct criterion is whether references exist.

  **If a retention policy is introduced into layer 2, state it in time** (§14.1-8). Stating it in
  generations cannot be executed by this function and would mean continuing to assemble explicit
  lists ourselves.

- **Do not set the `expire_older_than` option on the catalog.** It is a persisted default, and
  setting it makes **`ducklake_expire_snapshots()` with no arguments start running on a time basis**.
  `CHECKPOINT` calls it with no arguments precisely (§11-2.2). Our reclaim always specifies
  `versions` explicitly and does not even call it when there are no targets, so it is unaffected, but
  the setting itself is the trigger.
- It runs inside the purge job while holding the DuckLake ingest lock. The lock prevents it from
  dragging in the snapshot of the moment when an ingest has committed to DuckLake but not yet
  recorded it on the version row (DuckLake's commit uses a separate connection, so that window
  exists).

### 11-4 Set `parquet_compression` to `zstd`

**Set `parquet_compression` to `zstd`** (`CALL lake.set_option('parquet_compression', 'zstd')`).
DuckLake passes no compression option when none is configured
(`TryGetConfigOption("parquet_compression", ...)` in `ducklake_insert.cpp`), so **it is written with
DuckDB's default = snappy**. Layer 3's preview generation already specifies zstd explicitly
(`interpret/csv.ts`); only layer 2 was left at the default.

Measured (360 versions, base 20,000 rows, decomposed into column chunks and footers etc. with
`parquet_metadata`):

| Setting          |   Total | Column chunks | Footers etc. | Ratio |
| ---------------- | ------: | ------------: | -----------: | ----: |
| default (snappy) | 1.24 MB |       0.94 MB |      0.30 MB | 2.23x |
| zstd             | 0.60 MB |       0.30 MB |      0.30 MB | 6.98x |
| merge + zstd     | 0.38 MB |       0.31 MB |      0.07 MB | 8.05x |

**Column chunks shrink by 68%.** What a merge removes is the fixed cost of footers and the like, so
**the two remove different things and the effects add up** (1.24 → 0.38 MB). The setting only affects
subsequent writes, so files in an existing catalog stay snappy (harmless; measurements confirm a
catalog with two codecs mixed still reads).

### 11-5 Backup consistency

**PG (the catalog + the semantic layer + the version mapping) is the single source of truth, and the
S3 side is not restored** (ADR-037). Because the catalog lives inside PG, rolling PG back to time T
**necessarily aligns the catalog and the semantic layer at the same point**. Only S3 stays in "now".

**But S3 is not append-only.** `cleanup_old_files`, `delete_orphaned_files`, a purge's
`storage.delete` and lifecycle rules all delete. **And §9.8 deliberately decides not to couple
physical deletion to the PG backup retention period** — which means **a restore that spans a purge
necessarily produces, by specification, a state where the catalog points at deleted files**. It is a
consequence of the design, not an accident.

**And nulling alone is not enough.** Nulling `ducklake_snapshot_id` **only detaches the semantic
layer's pointer**; it does not touch the DuckLake catalog rows that name the missing files. **Reads of
that table's current content fail.**

Measured (DuckDB 1.5.4: save aside v1's catalog → load v2 → expire v1 + `cleanup_old_files` →
connect the saved catalog to the current data path):

```
SELECT count(*) FROM lake.t   → 50        ← returns the right value
SELECT name    FROM lake.t    → IO Error: Cannot open file "…-8050-….parquet"
```

🔴 **`count(*)` lies.** It answers from catalog statistics and never touches a file. **A health check
that counts rows reports "healthy" while every actual read fails.** If you are going to verify, read a
column.

**The recovery source is "the healthy layer-2 version with the highest recorded snapshot". Not the
live version.** The definition is **"among versions that are not purged and whose
`ducklake_snapshot_id` is non-null and actually resolves, the one whose recorded snapshot is
highest"**. **Not the highest version number** — this rewrites the head, so reading it in any other
order than the step-down's breaks §9.1's invariant (the head holds the contents of the
highest-recorded version) and the next purge misreads where the table stands.

**The live version must not be used as the reference.** The live version is not necessarily in
layer 2 — if the key is invalid the ingest refuses it (§6.6), its snapshot stays null and
**`lake_ingest_reason` also excludes it from the sweep**. In the perfectly ordinary state where v1 is
healthy and v2 is live with `key-missing`, using live as the reference drops into "null it → let the
sweep handle it" with no recovery source, and **the sweep does not pick that version up**, so nothing
gets fixed. What layer 2 tracks is **the newest successfully ingested version**, not live.

**There are two ways it breaks, and they are fixed differently.** What separates them is **whether
that newest healthy version exists**.

| What is broken                                       | The fix                                                                     | History |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ------- |
| Only the current head (at least one healthy version) | **Rewrite the head** from that version's snapshot                           | Kept    |
| No healthy version at all                            | Null the version rows that do not resolve → the sweep rebuilds from layer 1 | Lost    |

**Even in the second row some versions are not fixed.** A version carrying a `lake_ingest_reason` is
out of the sweep's scope, so nulling does not get it picked up. **That is correct** — that version was
already determined to have an invalid key and to be unable to enter layer 2, and it was that way
before the restore. The table stays empty until the next ingestible version arrives.

**The first row is the default case.** The current head is sometimes a snapshot no version row names
(a purge's step-down). **Anything unnamed is subject to reclaim, so it disappears later
to expire + cleanup** — restoring a PG containing that state gives **every version row resolving and
only the head failing**. Measured:

```
v1@snapshot 1 (named by a version row)  → readable
current head (unnamed snapshot 2)       → IO Error
Fix: CREATE OR REPLACE TABLE t AS SELECT * FROM t AT (VERSION => 1)
     → head restored, v1's history still readable
```

🔴 **Reconciliation cannot detect this path.** Every snapshot the version rows point at resolves, so
there is nothing to null and **the sweep does not run either** (`pendingLakeIngestQuery` conditions
on `ducklake_snapshot_id IS NULL`). **That is why detection must be "read a column of the head"**
(§4-4). The procedure of `DROP`ping and leaving it to the sweep **re-ingests nothing and loses the
table permanently** in this case.

**Using `CREATE OR REPLACE` to rewrite the head is the one exception.** What §7.2 forbids is **moving
content** by anything other than issuing a version, and this is not a move but **a reproduction of the
same content**. The ingest path cannot be used — a keyed `MERGE` reads the target table's current
content, so it will not run while the head is unreadable. And because it **touches no version row at
all**, the write-once rule is not broken.

**In the second row the version row's snapshot is nulled. That is not a rewrite.** Write-once forbids
"the same version coming to point at a different snapshot". Nulling **undoes that write**: the
version goes back to not-ingested and the sweep writes it **once, afresh**. It is not an exception for
restores; it is inside the rule.

**When neither fix applies** (layer 1 of the live version is gone too, i.e. purged), `DROP`. That
resource has no layer 2 until the next version arrives. **That is not a failed restore; it means the
purge succeeded.**

**We do not adopt a contract of unconditionally discarding all of layer 2.** What is broken is only
the table holding the missing files, and
there is no reason to drag untouched resources along with it. **The unit is the table (= the
resource)** — degrading per version is not enough, and the whole catalog is too wide.

### 11-6 Sweep `delete_orphaned_files` from cron

**`ducklake_delete_orphaned_files` is used by the cron sweep** (`sweep-lake-orphans`). Its targets are
files the catalog does not track (left behind by an abnormal termination after the Parquet write and
before the catalog commit), a different remit from expire / cleanup. The `olderThan` window is taken
generously so that a file still being written is not read as an orphan.

[ducklake#815](https://github.com/duckdb/ducklake/issues/815) (fixed;
[#863](https://github.com/duckdb/ducklake/pull/863) corrected the separator handling of `DATA_PATH`)
was about **files still in use** that had lost their `begin_snapshot` after an expire being judged
orphans and deleted. Our operation — a purge expires and cron sweeps — is exactly that combination,
and our `DATA_PATH` has a trailing slash (`lake/`) too. A regression test is in
`maintenance.ducklake.test.ts` — it passes because the fix is in, and reverting the extension to an
older version makes it fail.

### 11-7 Shapes considered and not taken (history)

**`rewrite_data_files` every 100 versions.** It worked on synthetic data (2000 rows with 20 changed
per version, so rows turn over roughly every 100 versions) — live 358 → 8, scan 24.2 → 7.1 ms,
storage +10%. The sweep over K is kept here too (1,200 versions, 10,000 rows; right after compaction
and after K-1 versions):

|   K | Scan right after | Scan just before | live just before |  Bytes just before |
| --: | ---------------: | ---------------: | ---------------: | -----------------: |
|  25 |           7.2 ms |           8.6 ms |               26 |            7.87 MB |
|  50 |           8.7 ms |          10.4 ms |               51 |            4.92 MB |
| 100 |           6.5 ms |          12.5 ms |              101 |            3.60 MB |
| 200 |           6.1 ms |          17.4 ms |              201 | 3.36 MB (smallest) |
| 400 |           6.6 ms |          32.2 ms |              401 |            4.60 MB |

**We did not take it because that shape is not the default for government data.** The deletion ratio
only rises when rows are reused frequently, and most real data is append-dominated, where appended
files carry no deletes. The synthetic data above having a turnover cycle is what made us overvalue
`rewrite_data_files`.

**But "it never appears" is not right either.** Current-event listings, notices with a posting
deadline, availability tables — **a certain amount of government data does turn its rows over**. For
such resources the deletion ratio rises, candidates appear and expire actually frees bytes
(§14.1-8). **Set the default for append-dominated data and handle the outliers individually** —
`MERGE_FILE_THRESHOLD` is a runtime setting (§11-2.1) and an entry point for choosing and invoking a
compaction function is in §14.1-9.

**Calling `rewrite_data_files` every version at threshold 0.95** (the shape "it only works when
candidates appear, so nothing is wasted"). **Misses really are free** — measured at 300 versions with
300 calls, it fired 0 times and consumed no snapshots (a call with zero candidates does not open a
transaction). **On append-dominated data it never fires**, so adding it does no actual harm.

We did not take it because the trade is bad under the conditions where it does fire. Counting on a
shape with fast row turnover (2000 rows, 1% updated per version, 1000 versions):

```
calls 1000  fired 310  read 401  wrote 310  of which consolidating 82
live 353 (358 if not called)  snapshots +312
```

**Three quarters of the firings just rewrote one file into itself** with no change in the file count.
Even counting the 82 consolidations, only 91 files net are removed while about 1000 are added over the
same period, so the scan improves by only 0.8 ms. The price is **a permanent 31% increase in
snapshots**. At a per-version cadence only one candidate appears at a time and there is nothing to
combine it with — it only works as a consolidator once the period is widened enough to accumulate
candidates.

**The function itself is a compactor, not a rewriter.** From the name and description ("rewrite files
with many deletes") it reads as a one-file-to-one-file operation, but in measurements, when several
files exceed the threshold, it **consolidates them into one** (`files_processed: 3, files_created:
1`). If a use for it arises later, specify threshold 0 explicitly (at the default 0.95, a file
containing just one row that should be discarded is not rewritten).

The mechanical difference against `merge_adjacent_files` is in §11-2.3.

## 12. Impact

- **DB**: `ducklake_snapshot_id` added to `resource_version` (ii-a). `resource_column` added (ii-b,
  the settled schema layer). A schema for the DuckLake catalog appears in the same PostgreSQL
  (managed by the DuckLake extension, outside Drizzle)
- **New package**: `@kukan/lake` (DuckLake connection, ingest, diffs, maintenance). The worker writes
  and the api reads
- **Worker**: the Lake step is added to the pipeline, plus compaction/expire maintenance jobs
- **API**: the diff API is added. `/query` is unchanged (the sandbox is preserved)
- **Web**: expandable diff display is added to the version history
  `resource-version-history.tsx` (ii-a, §7.1)
- **Deployment**: loading the DuckLake extension and configuring the S3 secret. MinIO needs
  path-style plus an explicit endpoint (§4, confirmed in the spike)
- **Existing**: layer 1, previews and the existing query path are unchanged

## 13. Test Strategy

- **Technical validation spike (done 2026-07-25, dev's PostgreSQL + MinIO)**: the following were
  confirmed. The layer-2 approach works.
  - `INSTALL`+`LOAD` of the `httpfs` / `postgres` / `ducklake` extensions (succeeds offline too)
  - `ATTACH` to a PostgreSQL catalog + a MinIO `DATA_PATH` (works with the connection requirements of
    §4)
  - Two-version ingest → an old version can be read via time travel `AT (VERSION => snapshot_id)`
  - `ducklake_table_changes(catalog, schema, table, start, end)` returns
    `insert` / `update_preimage` / `update_postimage` / `delete` with rowids and row values
  - **Keyless diffs are computed with `EXCEPT` between two snapshots** (v2 EXCEPT v1 = added,
    v1 EXCEPT v2 = removed). **ii-b uses the same endpoint comparison, with only the folding unit
    becoming the key** — `table_changes` is not used for diffs (§7; this originally said "used for
    tracking changed rows when there is a primary key")
  - Snapshot IDs increase monotonically **across the whole catalog** (not per table), so a design that
    records the ID immediately after each version's commit into
    `resource_version.ducklake_snapshot_id` is required
- **Pre-ii-b spike (done 2026-08-13)**: `MERGE` and purges were run against a real catalog and the
  results pinned as assertions. Left as prose they would go quietly stale with DuckLake updates
  (summarized in §14.0, details in the two files below).
  - `packages/lake/src/__tests__/merge.ducklake.test.ts` — the shape and limits of keyed ingest
  - `packages/lake/src/__tests__/purge.ducklake.test.ts` — how far a version purge reaches into
    layer 2 (§9.9)
- **Integration tests**: Lake ingest (version → snapshot recording), the statistical summary of
  keyless diffs, keyed `MERGE` diffs, schema-change detection, computing the explicit expire list,
  purge propagation to layer 2.
- **Sandbox regression**: that the existing `/query` cannot reach DuckLake (the ADR-032 isolation is
  intact).

## 14. Open Issues

### 14.0 What to read before starting ii-b

ADR-043 open issue 7 is the main one. **Three premises under which ii-a exceptionally held now fall
away.** All three are resolved (ADR-043 §5 was updated), but the shape of the solutions constrains
ii-b's design, so read it before starting. **1 and 2 were settled by dropping the follow mechanism
altogether, and that is implemented** (below).

1. **A rollback tells layer 2 nothing.** For a while `revertLiveContent` rolled the table back to
   layer 2's own step-down target (not the restore target itself, but the newest ingested version at
   or below it). **Landing §7.2 removed that whole mechanism** — once a rollback issues a version,
   layer 2 catches up through that version's ordinary ingest, so there is no separate "follow" path.
   `superseded`, `stepOffAbove` and `lakeMoveOwed` are all gone.

   What remains is the rule that **a rollback that empties the resource does not drop the table**.
   The versions it retracted are not `purged`, so it owes no unfetchability — and **not because
   dropping would stop the diffs resolving** (that was the original reason; a `DROP` does not cost
   the retained snapshots their readability, measured in §9.1). The head is therefore left holding
   retracted rows (open issue 16).

2. **An ingest's base is the contents of the version loaded last** (whatever state that row is in
   now — §9.1). That is not something
   the ingest arranges for itself; it follows from three other rules — an ingest refuses to load
   while a higher ingested `active` version exists, a rollback issues a version, and a purge makes
   its step-down target the head. So **there is no separate step that returns the head to the base**
   (the former `standOnBase`). One existed for a while, but what it repaired was a failure of 1's
   follow-up, and the follow-up itself is gone.

   **The base is read off the recorded snapshot, not the version number** (§9.1). Do not get this
   wrong when ii-b resolves a base in code: with v1@13 and v2@9 active, what the table holds is v1's
   contents, not "the preceding `active` version" v2. A purge's step-down (`lakeStandDown`) answers
   the same question off the same order.

   Note that the original idea — "point only the check for whether columns moved at the preceding
   active version's snapshot" — does not work: pointing only the check at the base still leaves the
   write side's `DELETE` + `INSERT` running against the columns of the table's current content, so if
   head and base disagree the INSERT fails. **What ii-b's `MERGE` needs is the head itself, not a
   check.** The only divergence left is a purge that failed partway through its step-down, and what
   repairs that is the retry of that purge (open issue 16).

3. **Purges are per version, but the range is an operator's judgement.** Under diff application, one
   file holds history-only rows alongside current rows, so a version purge does not necessarily reach
   the layer-2 bytes. **A version purge claims "making it unfetchable" and does not guarantee erasure
   of layer-2 bytes.** The decisions and the procedure are in **§9**.

#### What the ii-b implementation landed (done)

**Version rows' snapshots are write-once** (§7.2). A rollback is replaced by **issuing a version**
(ADR-044 revised), the `superseded` rows the old scheme left behind have been converted, and
`standLakeTableOn` / `lakeStandsAhead` / `lakeMoveOwed` / `standOnBase` are gone. **The purge's
step-down is the only thing that moves a table's current content**; it goes through
`restandLakeTable` (§7.2's three branches) and the landing snapshot is named by no version row.
**This item originally gave "a version whose ID was rewritten even once cannot be an endpoint for
`table_changes`, and the failure surfaces as an empty diff" as the reason it could not be done
afterwards. Now that diffs are endpoint comparisons, that reason is gone** (see the note in §7.2).
The reasons it was landed are the two in §7.2.

**`packages/lake` never looks at version rows**: it receives snapshot numbers, and the caller does
the recording. The invariant about the base, however, is upheld by **`ingestVersionIntoLake`'s
refusal** (do not load while a higher ingested `active` version exists), not by
`ingestParquetVersion`. When the signature is rewritten for `MERGE`, check that this refusal and
`pendingLakeIngestQuery` still state the same condition — loosen one and you get versions queued
hourly and refused every time.

#### Properties of `MERGE` settled against a real catalog

DuckDB 1.5.4 / ducklake `d318a545`. The assertions are in
`packages/lake/src/__tests__/merge.ducklake.test.ts` — they are claims about someone else's
implementation, and left as prose they would go quietly stale with DuckLake updates.

- ✅ **`when_matched` accepts only one UPDATE/DELETE action** (as expected). The error is
  `MERGE INTO with DuckLake only supports a single UPDATE/DELETE action currently`.
  `INSERT` does not count towards it, so an upsert (UPDATE + INSERT) passes as one action
- ❌ **"upsert + `WHEN NOT MATCHED BY SOURCE THEN DELETE`" cannot be written in one statement.** It
  hits the constraint above directly. **Split it into two statements**:

  ```sql
  BEGIN TRANSACTION;
    MERGE INTO … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …;
    MERGE INTO … WHEN NOT MATCHED BY SOURCE THEN DELETE;
  COMMIT;
  ```

  Wrapping them in a transaction **folds them into one snapshot**, so "one version = one snapshot"
  holds (the same reason and the same shape as ii-a's equivalent branch wrapping `DELETE` + `INSERT`)

- ✅ **The ingest does not depend on history.** In this two-statement shape, **the content after the
  ingest is determined by the version's bytes alone, independent of the preceding state**. Confirmed
  by loading the same version onto a table that has never seen v1 and shares no keys and getting an
  identical result. All of ii-b rides on this property
- ✅ **`ducklake_table_changes` returns `update_preimage` / `update_postimage`.** With a
  single-statement upsert, one changed row comes back as one pair (something keyless ii-a could not
  produce)
- ⚠️ **But in the two-statement shape, changed rows are returned several times.** The delete-side
  statement rewrites the file the upsert wrote, so even untouched rows are reported again. **If you
  count events, count distinct `rowid` rather than rows.** In measurements, two
  `update_postimage` rows came back for the same `rowid`.
  **The diff API does not depend on this** — it matches the content at both ends rather than reading
  events, so neither duplicate reporting nor cancellation matters (§7, "diffs are produced by matching
  the endpoints"). It is kept here because it is needed when reading events to verify an ingest.
  Reproducing it needs **both "two statements in one transaction" and "inlining off"** (putting the
  two statements in separate transactions behaves correctly, as does leaving inlining at its
  default). We set inlining to 0 for the reasons in ADR-043 §6-1, so there is no way out.
  Reported as [ducklake#1387](https://github.com/duckdb/ducklake/issues/1387)
- ⚠️ **Duplicate keys pass silently.** With a source containing duplicate keys the MERGE succeeds and
  **one of the rows disappears** (with no notice, and no telling which survives). Settled upstream:
  [duckdb/duckdb#24058](https://github.com/duckdb/duckdb/pull/24058) (merged, but after v1.5.5 so
  **unreleased**) defines "a `WHEN MATCHED` that touches one target row twice is a cardinality error".
  After a DuckDB update it will **throw**, so the ingest side needs an error path.
  It also appears in [ducklake#520](https://github.com/duckdb/ducklake/issues/520), where the DuckLake
  answer is "deduplicate in the source"
- 🔴 **Even that fix leaves half the hole open.** #24058 explicitly excludes `WHEN NOT MATCHED`.
  **Duplicate keys that do not exist in the target are both INSERTed** and the key stops being a key
  inside the table (measured). And it is self-propagating — in the next version one source row matches
  two target rows and both get updated. **Pre-ingest validation is mandatory regardless of version**
  and is not something that can be turned off by configuration
- ✅ **Composite keys work.** `ON t.a = s.a AND t.b = s.b` passes on both halves. However
  `count(DISTINCT a, b)` is a **binder error**; `count(DISTINCT (a, b))` or a subquery is required
- 🔴 **NULLs in key columns never match.** `=` does not satisfy `NULL = NULL`, so they are re-inserted
  every version. **The duplicate validation does not catch this by design** (`count(DISTINCT)` does
  not count NULLs, so it only trips over it by accident). Separated out as a rule in §6.4
- ✅ **Time travel over a table with delete vectors is transparent.** A keyed ingest produces row
  deletions rather than file replacement, but `AT (VERSION => …)` returns both the before and after
  versions correctly. The purge reclaim and the diff both depend on this
- 🔴 **A `DELETE` inside a transaction takes the time-travel read of the same table with it.**
  `BEGIN; DELETE FROM t; INSERT INTO t SELECT * FROM t AT (VERSION => n); COMMIT` **inserts zero rows
  and empties the table whenever the current contents and `n` share files** (measured; no error). It
  returns the rows correctly when they do not — ii-a's loads replace the contents wholesale, so the
  head's files and an earlier version's never intersect and **this shape does not bite under ii-a**.
  **ii-b's keyed load updates rows in place, so it always shares.** A re-load therefore **reads the
  snapshot out into a temp table before deleting anything** (`restandLakeTable`). Measured in
  `merge.ducklake.test.ts`
- ⚠️ **Rewriting a version row's snapshot makes `table_changes` silently return empty.** The former
  `standLakeTableOn` overwrote the rollback target version with a new ID, inverting it against the
  version-number order, and `table_changes(6, 5)` returns **0 rows** (measured). Not an error.
  **Diffs do not hit this, though** — an endpoint comparison does not depend on the ordering of
  snapshot IDs and answers correctly even with an overwritten ID (measured in §7.2). At the time this
  was marked 🔴 and used as the basis of §7.2, but **it became unreachable the moment diffs became
  endpoint comparisons**. Write-once means the rewrite no longer happens at all, but it still applies
  when reading events to verify an ingest
- ⚠️ **`CREATE OR REPLACE TABLE` looks like "all rows inserted" in the change feed.** A diff spanning
  one shows every row as an addition (measured `insert=3`). Time travel and
  the diffs of later versions are untouched, so the damage is confined to that one snapshot. ii-a's
  diff uses `AT (VERSION => …)` + `EXCEPT ALL` and is unaffected.
  It is the flip side of the behavior a maintainer described as "it is treated as a different table"
  in [ducklake#330](https://github.com/duckdb/ducklake/issues/330) (closed). The close was about
  conformance to the change feed specification, and this appearance is unchanged in the current
  version (the measurement above is `d318a545`).
  **A rollback now issues a version, so it never takes this shape.** What is left is the third of
  §7.2's three branches (a re-load whose column set differs), where nothing else can be composed

### 14.1 Subsequent issues

> ✅ **Nothing is left that release requires** (0 and 13 are done). What follows is for alongside
> ii-b or after it. The numbering is not compacted because the existing cross-references are live.

0. ✅ **[implemented] Layer 2's rollback target on a purge is looked up separately from layer 1's.**

   `executePurge` used `newestActiveVersion()` for both layer 1 and layer 2 when purging a live
   version, and `dropLakeTable`d if that version had no snapshot. With **v1 ingested / v2 live but
   not ingested / v3 ingested**, purging v3 could return layer 1 to v2, but layer 2 — which should
   return to v1 — had its table dropped instead. "A live version that has not been ingested" arises
   today with **an oversized version or a non-tabular version**, without waiting for ii-b's invalid
   keys. And `dropLakeTable` does not null surviving versions' `ducklake_snapshot_id`, so the sweep
   (conditioned on `ducklake_snapshot_id IS NULL`) did not pick it up — the same permanent loss as
   the one found in the restore of §11-5.

   The target is now read by `versionsLakeCanStandOn` (`active`, snapshot non-null, newest load
   first),
   and **snapshots the catalog no longer resolves are skipped** (the §11-5 measurement is pinned in
   `maintenance.ducklake.test.ts`). `DROP` happens only when there is no candidate at all; **with
   candidates that none of which resolve, the purge fails** (§9.1 — dropping there leaves nobody able
   to repair it).

   **The step-down condition changed too, from "is it the live version" to "does layer 2 stand on
   it"** (§9.1). The old condition was wrong in both directions, and where an intermediate version
   was the top of layer 2 it moved nothing — leaving the purged rows as the table's current contents.

   At the time, "where should layer 2 be standing now" was asked in three places — the revert's
   reconcile, the repair button and the ingest — so they were made to **ask through one function**
   (disagree, and either retracted rows stay with no warning shown, or the repair button never
   clears). **Now that §7.2 has landed, the purge is the only one that asks** — the other two went
   with the follow mechanism. The tests are in `lake-restand.integration.test.ts`.

   **A `DROP` costs the current contents only** (measured, §9.1). The earlier claim that it took
   "v1's history with it" was wrong: the retained snapshots read through a `DROP`. What is permanent
   is that nobody puts the head back.

1. **Widening the query targets**: currently ≤50MB CSV/TSV. Raising the limit, JSON and so on (the
   same root as ADR-032/043)
2. **Put compaction in the ingest job**: the decision of §11-2.1 (a thresholded
   `merge_adjacent_files` at the end of an ingest) has neither a period nor a firing unit, so **do not
   create a separate periodic job**. It goes at the end of the ingest and targets only that
   resource's table. Making it sweep the whole catalog would touch resources that have stopped being
   updated.

   **Make `MERGE_FILE_THRESHOLD` a runtime setting per ADR-036** (§11-2.1). The default of 50 was
   measured on the adopted write path and was not the worst on either the write or the read side.
   **The reasons
   to move it are two** — the reader's parallelism and **that resource's floor** (the live file count
   below which nothing folds). Firing below the floor is a miss, so measure the floor first. It is
   right to tie the decision to the ECS task definition (the ADR-031 environment definitions carry
   CPU).

   Re-measuring is covered by `pnpm bench:lake`, but **the real-world read/write ratio** is needed
   separately — a merge happens once per publication while a scan happens on every read, so only with
   that ratio can the upper side of T be decided (§11-2.1).

   **Revisit `QUERY_THREADS` / `LAKE_INGEST_THREADS` (both 2) before T.** Scanning is latency-bound,
   so it is worth raising threads beyond the core count — on 2 vCPU, 2 → 8 threads is 2.45×, and the
   plateau was at 8 regardless of core count (§11-2.1). **2 is the worst point in everything
   measured, and it does more than T at no cost** (48.1 → 32.9 ms at the same T=25, with no change in
   merge count). The two have different purposes, though: `LAKE_INGEST_THREADS` is the worker's own
   work so it can simply be raised, while `QUERY_THREADS` is a resource ceiling on user SQL
   (ADR-032), where raising it multiplies concurrency by thread count.
   **If it is raised, "only when the data path is remote" is the right rule** — it does nothing on a
   local FS.

   In the same place, **consider `httpfs_connection_caching = true`** (§11-2.1). Left at its default
   of false it opens 140 TCP connections per scan; enabling it makes that 6 and cold scans 1.4–1.75×
   faster. **We have not confirmed why the default is false** — check upstream's intent (stale
   connections, proxy compatibility) before enabling it. It is a one-line win, but today's
   measurements do not go as far as saying it can be enabled unconditionally.

   **Lower `target_file_size` once layer 2 reaches hundreds of MB** (the table in §11-2.1). One merge
   writes `min(table size, target)`, so only the band where the table is comparable to target is
   pathological, and lowering it escapes that band. **It is sounder than a period K** — the right K
   differs per resource, whereas this is stated in the language of size ("how many bytes may be
   written at once") and the same value carries meaning whether the table is 1 MB or 100 GB. Choosing
   a value needs GB-scale measurements (today's only reach 18 MB on disk)

3. **Multi-site (ADR-041)**: split the catalog per site, or a single catalog with a table-name prefix.
   Accounting for it in the connection budget
4. **AI suggestions for keys/types (ii-c)**: an ADR-040 extension. Deterministically compute column
   profiles (uniqueness rate, null rate, value patterns) → present candidates
5. **Unapproved patch/proposal flow**: a "propose a replacement → commit on approval" workflow
   (future)
6. **What a tombstone shows**
   - **Group consecutive tombstones.** Purging versions in a row leaves dozens of them lined up as
     `purged`. Printing them one per line repeats the same information and even lets one read off
     "from when to when the removed content was published". Group them as `v10–v60 withdrawn`. The API
     does not need grouping (§9.6), but display is a different matter
   - ✅ **[implemented] `purgeReason` is off the version view**. The reasoning lives on
     `VersionView`'s doc. `purgedAt` stays — it explains the gap in version numbers and leaks no
     content. **It left silently, so its absence is pinned** at both levels: the service (a
     tombstone's view) and **the route** (an anonymous `GET /resources/:id/versions`, where the
     assertion also checks the reason's text appears nowhere in the body). The admin guide's "the
     history keeps the reason" was corrected with it — **that is the page read before typing into the
     field**, so leaving it stale invites restating there what had to be removed
   - **The reason text itself remains, though: what was dropped is the exposure, not the record.**
     `resource_version.purge_reason` is the durable place the reason lives between the claim and the
     completion (the ADR-028 claim pattern; the completion's audit entry reads `row.purgeReason`), and
     the audit log carries the same text. So **there is no path for "erase what I typed into the
     reason field"** — an operator would have to clear the column and the matching audit entries, and
     no tool does that (the same class of gap as open issue 15). **Prevention is the only means, so
     the operational procedure says "do not type into the reason field what has to be erased"** (it is
     in the admin guide). Dropping the column itself would mean accepting that the completion's audit
     entry loses the reason (the claim's entry keeps it), and entails a migration
   - **And the audit log has no read path.** `auditLog` is only ever inserted into; no API and no
     screen reads it. "Accountability is served by the audit log" therefore holds **only for whoever
     can reach the database**, and an operator-facing way to look a purge reason up is separate work —
     when it is built it must be sysadmin-only and say so, since it is the place that shows exactly
     what was dropped here

7. **Sweep parked objects immediately at purge time** (§9.8). A preview created by an intermediate run
   is merely parked in `orphaned_object` when replaced, and the purge does not hurry it along. For an
   hour plus the sweep interval, a preview containing contaminated rows can remain in storage. It is a
   current window that does not wait for ii-b, and purging several versions at once multiplies it by
   the version count
8. **Apply the retained generation count to layer-1 bytes only** (if the diff approach is taken, that
   is where to cut). Layer 2 with diffs is two orders of magnitude smaller, while layer 1 holds a
   complete copy of the whole table per version. **Snapshots are kept for every generation**, so
   surviving versions' references never break and the dangerous ordering of §11-2.4 stays
   unreachable. The mechanism already exists — a purge's tombstone is "keep the row, erase the bytes",
   and this is its inverse (erase the bytes, keep `ducklake_snapshot_id`). Three things need
   designing:
   - **Only target versions layer 2 can answer for.** Non-tabular versions and those with
     `too-large` / `too-many-columns` / `no-columns` have no layer 2, so erasing the bytes loses the
     content entirely. The material for deciding is available from §6.6's `no_table_reason`
   - **"No bytes but there is data" cannot be expressed.** `state` has four values and `storage_key`
     is `NOT NULL`. Reusing `purged` is impossible because it is displayed as a purge tombstone. The
     version history UI needs a column or state that can indicate "not downloadable, diffable"
   - **A premise of ADR-043 inverts.** Layer 2 stops being "a derived index that can always be rebuilt
     from layer 1", and for old versions **layer 2 becomes the only record**. A decision is needed on
     the ADR side
   - **The retained generation count also defines layer 2's recoverable range.** Layer 2 can only be
     recovered by re-streaming from layer 1, so a version thinned out of layer 1 will not get its
     row-level diff back. That is consistent rather than contradictory — a thinned version's content
     cannot be downloaded in the first place, so both fall away over the same range. The only
     constraint is that **they cannot be decided independently**
   - **The trigger is the catalog's row count, not object capacity.** With diffs + merge, layer-2
     bytes grow by only 3.4 KB per version (0.67 MB over 200 versions). The catalog, meanwhile, grows
     by about **4.7 rows per version** and **never shrinks** — measured (1 resource, 200 versions):
     `ducklake_snapshot` 206 rows, `snapshot_changes` 206, `data_file` 133, `delete_file` 132,
     `file_column_stats` 266. A merge removes `data_file` rows but keeps snapshots. **Only expire can
     reduce that.**
   - **And expire reduces only those row counts, not the bytes** (measured). With 200 versions of
     history, expiring every snapshot but the newest plus `cleanup_all` left **820 kB exactly as it
     was** (snapshots 206 → 1). **On append-dominated data no file ever becomes history-only** — every
     version's file holds current rows, so erasing history produces nothing to free. **This is not a
     property of the diff approach in general; it is decided by how fast rows turn over** — on
     synthetic data where rows do turn over (2000 rows, 1% per version, 300 versions), the same expire
     took total files from 302 to 100 and 0.26 to 0.08 MB. Real data being append-dominated makes the
     former the default, but for fast-turnover resources expire does become meaningful. Inserting
     `rewrite_data_files` only gives 820 → 788 kB (4%): the delete vectors nearly vanish but the data
     side grows and cancels it out (674 → 774 kB). **If you want to reduce bytes you need to fold
     live** (§9.2). A layer-2 retention policy exists for the catalog's row count, not for capacity
   - **If a retention policy is introduced on the layer-2 side too, state it in time, not
     generations.** Layer 2's retention unit is a catalog-wide snapshot, and the only function that
     cuts them takes `older_than` (global time) (§11-3). "The latest N versions of each resource"
     cannot be mapped onto that axis — the same line in time is a completely different generation
     count for an hourly-updated resource and a yearly one. **Layer 1 in generations, layer 2 in
     time** is the split that fits the format. It is tempting to write layer 2's retention in the same
     words as layer 1's, but the expressible forms differ

9. **Manual vacuum** (explicitly running compaction per resource from the admin screen). The
   per-ingest `merge_adjacent_files` is a default tuned to append-dominated data, and for resources
   with fast row turnover (current-event listings, notices with a posting deadline, availability
   tables and so on) there is still room for `rewrite_data_files` to help. But **it only helps once
   candidates have accumulated**, and whether that happens depends on the row turnover rate (the
   history in §11-2.1). Automatic detection would mean duplicating DuckLake's candidate conditions on
   our side, and if upstream changes them it drifts silently — indeed we misread the leading
   `total_delete_count == 0` check. **An entry point an operator can press once they notice "this
   resource is heavy" is enough.** Make the threshold and the target function selectable and return
   the results (`files_processed` / `files_created`).

10. **Purging with the corrected version first (zero data loss)** (§9.7). Erasing only N..live-1 while
    keeping live; it worked in measurements. In the diff approach, only this shape needs live folded
    with `CREATE OR REPLACE TABLE t AS SELECT * FROM t` — in the default N..live the rollback does the
    same job so it is unnecessary, but here no rollback runs. **Write the fold as part of the
    procedure.** Skipping it produces no error; it just completes quietly with more rows left in
    layer 2

11. **Revising ADR-044** (§7.2). Changing rollback from "go back" to "publish that content again"
    moves the revert contract (`restoreTo` + `ifLiveRevision`) and the position of `superseded`. The
    ADR has been revised, and the three remaining points are settled:

    - **Abolish `superseded`** (§7.2). Remove `stepOffAbove` and consolidate **layer 1's automatic
      fallback after a purge** as "the highest `active` version" — not the definition of live,
      which is the owner of the object the pointer names and mid-purge can be a `purging` version
      (§9.6). The rule where `restoreTo` refuses a `superseded` version (no redo) falls
      away at the same time. **Existing `superseded` rows are converted** — leaving them alone was
      the first answer, on the reasoning that returning them to `active` moves live. **Live is the
      owner of the object the pointer names**, not a version's rank, so the state change does not
      move the pointer; what moves is the purge fallback, which this same §7.2 already accepted.
      Left alone, the readers carry two regimes for good (the table in ADR-044 §4)
    - **Rewritten snapshots are left alone too.** ADR-044 shipped in v0.11.x, so there may be versions
      whose snapshots have already been rewritten. **Endpoint comparison reads those correctly**
      (measured in §7.2), so no migration is needed for diffs. All that remains is "a rewritten
      version does not satisfy the new write-once invariant", and once rewrites stop happening that
      version's ID stops moving too
    - **`restoreTo`'s response keeps `restored`.** What it returns today is "the destination version
      that was named", and that meaning does not change. **What changes is that a published version
      exists alongside the destination**, so its number is added as a separate field. Moving
      `restored` to mean "the published version" would make the same response shape point at a
      different number, which an older caller cannot notice

12. **Explicit re-ingest of rejected versions** (§6.6). A version carrying a `lake_ingest_reason` stays
    out of the sweep's scope and does not return automatically even after the key setting is fixed,
    because of §6.4's "a key-specification change applies from later versions". Decide whether to
    build an entry point after seeing whether the demand to re-ingest past versions actually arises.
    If it is built, it will take the shape of **"rebuild layer 2 per resource with the key as of this
    point"**, which keeps the key scheme aligned better than picking versions one by one.

13. ✅ **[implemented] The purge confirmation screen answers "is the target live".** The three
    branches of §9.6 did not hold, and the wording papered over it by stating both conditionally.

    The version view (`VersionView`) carries **`isLive`** and **`purgeFallsBackTo`** (the version
    serving would land on if this one were purged, **set only for the live version** — purging any
    other one does not move serving, so an answer there would name a move that never happens), so
    **the screen picks its branch by reading two facts** — neither rule exists client-side. `isLive` is decided by
    `liveVersion()` — the read of
    the pointer's owner that the purge itself decides from — counting `active` / `superseded` /
    `purging`. The list, the single-version view and the purge claim's response all carry the same
    answer. **The client must not guess from version numbers or the count of active versions**
    (§9.6). Integration tests pin **two shapes**: after a revert (v2 highest and not live, v1 live
    and not highest) and **with a claim taken on the live version** (`purging` v2 live, `active` v1
    not) — the second is the only shape that breaks "the highest active version", and the first alone
    would not have caught it.

    **The rows and the pointer are read as one snapshot** (a `repeatable read`, read-only
    transaction). Read separately, a concurrent revert interleaves them — a list from before it, a
    pointer from after — and the screen names a fallback the purge will not use. **The claim's
    response is built from the same kind of read**, after the claim commits: a claim is a write and
    locks only its own row, so reading the rest of the resource inside it does not hold back a revert
    moving the pointer and stepping other versions off.

    **Where no version owns the pointer the answer is a guess** (`liveVersion`'s hash fallback).
    It is still the right thing to show, but **the part that holds and the part that can be wrong
    are different**: **the prediction holds** — the purge acts on the same guess, so what happens
    to the version named is what the screen said — while **the identification, "this version is
    what is being served", can be wrong**, landing on another version whenever several hold the
    same bytes. **The guess survives the conversion** (§7.2 decision 6) — an unowned live object is
    a permanently normal state (ADR-044 §4). What the conversion removes is the `superseded` row
    above live that takes the guess; with every version `active` it answers the topmost one, which
    is the version that content is.

    **A resource serving nothing has no box among the three cases.** Every version reads
    `isLive: false`, so the screen says "not what is being served" when nothing is being served (after
    a revert that emptied the resource). The wording is not false; whether §9.6's table gains a fourth
    row is undecided.

    **The conditional phrasing stayed.** Live can move between opening the confirmation screen and
    confirming (another run's publish, a concurrent revert). What the API answers is "which is live
    now", not "which will be live at the moment of confirmation": the three branches show what is
    coming, they do not promise it, and the wording says as much (`purgeCaseMayMove`).

    **The choice of wording is pinned.** `resource-version-history.test.tsx` has a test per branch,
    each asserting the other branches' sentences are **absent**, plus one for the shared text (the
    caveat, download-first, layer-2 rows may remain). **The fallback rule is held by the integration
    tests**: `superseded` and `purging` rows are not candidates, and with two standing versions each
    names the highest that is not itself. The E2E
    suite (`resource-versions.e2e.ts`) carries the post-revert shape: live on v2 with v3
    `superseded`, where v3 must read "not what is being served" and v2 "serving falls back to v1".
    **Version order answers the opposite there** (the `active`-filtered rule is broken by the claim
    shape above, which the integration tests hold).

14. **The confirmation screen's later-version check (the N → N+1 diff) is unimplemented.** §9.3 asks
    for it as "a firmer brake than a warning message", but all today's dialog has is a warning and a
    notice about an identical hash. Purging an intermediate version **only means something when the
    content was not carried forward**, so without it the operator cannot notice "I thought I erased it
    and I did not". The diff API and `VersionDiffPanel` already exist, so calling the same path from
    the dialog is enough.

15. **There is no cleanup for unresolvable snapshots.** Implementing open issue 0 made the purge fail
    and stop when there are candidates and none of them resolve (dropping there leaves nobody able to
    repair it). **There is no tool to repair what stops** — §11-5's path (null the unresolvable
    `ducklake_snapshot_id` and let the sweep re-ingest from layer 1) is not implemented. Three
    operational pieces are needed, none of which waits for ii-b:

    - **A head health check.** Read a column, as §11-5 says (`count(*)` answers from catalog
      statistics and lies). Reconciliation only looks at whether version rows resolve
    - **Nulling version rows that do not resolve.** The only operation that puts them back in front
      of the sweep. Versions carrying a `lake_ingest_reason` stay excluded, and that is correct
      (§11-5)
    - ~~**Decide whether the revert and `standOnBase` also check resolution.**~~ **Gone** — the
      purge's step-down is the only operation left that rides a recorded id to move contents, and it
      walks resolution already (§9.1)

16. **The head can be left disagreeing with the surviving versions' content.** Two paths lead there —
    **a revert that empties the resource** (the retracted rows stay, which follows from owing no drop,
    §9.1) and **a purge that failed partway through its step-down** (the purged version's rows stay,
    and while that version is `purging` it is not a step-down target either). Both are harmless
    today: no product path resolves to the head, and ii-a's ingest replaces the contents wholesale.
    **ii-b needs two things:**

    - **`MERGE` must have the rule "with no base, start from empty".** With nothing to stand on the
      table is left as it is, so left alone it loads the next version on top of retracted rows
    - **If the decision flips to dropping, the repair path needs it too.** `repairDerivatives` goes to
      `clearEmptied` for an emptied resource and never looks at layer 2, so dropping inside the revert
      alone leaves no way in when that one attempt fails

17. **"Which version layer 2 stands on" rests on what the version rows record.** The purge
    answers it from the recorded snapshots, as "no `active` version was loaded after this one", so it
    is wrong for a table
    left by a crash **between the DuckLake commit and the write of the id onto the version row**
    (`ingestVersionIntoLake`). The purge falls the safe way — reading "it stands here" when it does
    not costs the contents, and the sweep re-ingests from layer 1 — but **the answer is never stronger
    than the recording**, which is worth seeing before ii-b's `MERGE` takes the current contents as
    its base. Closing the window needs the ingest to record first (write-ahead, the shape of ADR-045)
    or a read of the head to confirm.

## 15. Out of Scope (Phase iii)

- The viewer-facing "changes from the previous version" UI, and version-pinned queries
- Integrating the preview Parquet into a DuckLake export (consolidating the generation path)
- MCP diff tools (`get_resource_diff` etc.)
- Iceberg export (external engines reading published snapshots directly)

## 16. Related ADRs

- ADR-005: only four adapters (DuckLake is isolated in `@kukan/lake` and is not made an adapter)
- ADR-017: server-proxied download/preview (the diff API's visibility check)
- ADR-028: the durable claim of asynchronous purges (purge state transitions)
- ADR-029: column type inference (the basis for type determination and demotion)
- ADR-032: the MCP data query foundation (the premise of sandbox isolation; the diff API is a separate
  path)
- ADR-036: runtime system settings (retained generation count, maintenance period)
- ADR-037: the backup strategy (the consistency rules for layer-2 expire/cleanup)
- ADR-040: AI metadata suggestions (the future extension for key candidates and type suggestions)
- ADR-041: multi-site deployment (the open issue of splitting the catalog)
- ADR-043: resource versioning and row-level diffs (the design of the layer 2 this phase implements)
