# ADR-043: Resource Versioning and Row-Level Diff (DuckLake)

## Status

**Accepted** — layer 1 implemented 2026-07-25, layer 2 (ii-a) 2026-07-27.
ii-b (changed-row tracking via a declared primary key) onwards remain open issues

> **The ii-b design revised §5 (purge) and §6 (operations) on 2026-08-17 (not built).** The
> largest change is that **a purge no longer guarantees the erasure of layer 2's bytes**, and
> the phrase "legal deletion" has been dropped from this ADR with it. What changed is noted at
> the head of §5; the full list of decisions and the measurements behind them are in
> `docs/specs/en/phase-versioning-2-ducklake.md` §0.

Introduces versions for canonical resource data and, for tabular resources, provides
row-level diffs between versions, time travel, and column schema change history.
Adopts DuckLake as the table format (catalog = existing PostgreSQL).

## Context

Before this ADR, a resource's canonical file was uploaded by **overwriting** a fixed storage key
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

- **A) Three-tier fallback (adopted)**: Degrade diff granularity based on primary-key presence
  and schema changes (Decision §3). Without a primary key, do not force row matching —
  **never fabricate change history from guesses**.
- **B) Attempt row-hash matching for all resources**: Could always estimate "changed rows,"
  but without a primary key, changes cannot be distinguished from add+delete pairs, risking
  presentation of incorrect history. Rejected.

## Decision

**Introduce versions and diffs in a three-layer structure.**

```
Layer 1: Canonical version files (all formats)
         the object each version owns — usually the live one, a copy of the same shape
         when that was already owned — immutable, tracked by resource_version
Layer 2: DuckLake (tabular resources only)
         1 resource = 1 table. Row-level diff, time travel, column schema history
         Catalog = existing PostgreSQL; data files = existing S3/MinIO
Layer 3: Preview Parquet
         What interpreting a layer-1 version produces (ADR-046). Whether it becomes an
         "export from the latest DuckLake snapshot" is undecided (ADR-046 open issue 4)
```

**DuckLake (Layer 2) is positioned as a derived index that can always be rebuilt from
Layer 1.** The canonical source is the Layer-1 version files; the DuckLake catalog and
data files can be regenerated by reprocessing all resources. This keeps format risk
(migration, corruption) in the same class as the preview Parquet.

### 1. Layer 1 — Canonical version files

1. **All formats are covered** (including PDF, images, ZIP, etc.). Even for non-tabular
   data, "when, by whom, replaced with what" history is meaningful.
2. When content arrives — an upload being promoted, or a Fetch downloading — a version is
   created. **A version owns the bytes it names**: the purge destroys them, so it may not
   while anything else describes the same file (ADR-046 §3). The rule is therefore ownership:
   **take an object nothing owns, copy one that is already owned.**

   |                    | Key                                          | Who points at it               |
   | ------------------ | -------------------------------------------- | ------------------------------ |
   | live               | `resources/{packageId}/{resourceId}.{token}` | `resource.storage_key`         |
   | version (ordinary) | the same key as live                         | `resource_version.storage_key` |
   | version (copied)   | a new key of the same shape                  | `resource_version.storage_key` |

   Ordinarily nothing owns the object a fetch has just written, so the version takes it. The
   copy is what **live not moving** leaves: an upload keeps its key and a revert puts live
   back onto a version's object, so an interpretation change there would point at the previous
   version's file. **When it copies, live moves to that key too** — "live names the newest
   active version's object" is what the purge decides from, and leaving it behind has the
   purge of an older version delete what live is serving.

   **Both keys carry a UUID unique to the write that made them, but for opposite reasons.**

   - **The live key moves.** A resource has exactly one at a time, and it becomes a different
     key whenever the content changes; the old one is booked for reclamation and swept. The
     UUID is what guarantees the pointer landed on a **different object** than before
   - **A version key never moves.** One version has one key, and it does not change once
     written. The UUID is there for **retries**: derived from the version number alone, a
     failed attempt at v5 would have its retry write to the key of the abandoned object — and
     the sweep may be on its way to delete it, so the row would point at something **deleted
     moments later** (ADR-045 §3)

   Nothing recomputes a key; every reader follows a pointer column. So a failed write leaves
   whatever was live untouched — it was never the target.

   **"Write to a temporary key and rename to `v5`" does not solve this.** S3 has no rename, so
   it becomes copy + delete — more work, and **the race does not go away, it just moves to the
   last step**: `v5` needs its own write-ahead record before the copy (ADR-045), so an attempt
   that dies before its row insert leaves `v5` orphaned and the retry writes `v5` again. The
   sweep's check-then-delete window opens exactly as before. Writing each attempt to its own
   key is what gives the sweep the property it relies on — **a writer cannot name the key it is
   deciding about**.

   The price is unreadable keys: nothing in the bucket says which object is v5. That only bites
   during hands-on investigation, so if it needs solving, the place to solve it is an admin
   screen showing `storage_key` — not the shape of the key.

   **Creating a version** means only this — take ownership of an object and number it
   (`createVersion` in the code). It reads nothing, not even whether the content is tabular
   (ADR-046).

   **What triggered it makes no difference.** Whether the bytes changed, or the bytes are the
   same and only the interpretation changed (ADR-046 decision 3), the act is this one — a
   version made by a changed interpretation still gets its own version file (ADR-046 §3). All
   that differs is why the gate in §1-4 said yes.

   **A version begins to exist when its row lands, not when the copy is made.**

   ```
   1. decide  does the hash or format differ from the previous version, and is the
              live pointer still this run's?
   2. own     unowned → the version names the live key; insert the row and stop
              owned   → reserve (ADR-045) → copy → one transaction: insert the row
                        and move live onto that key
   ```

   Ordinarily it ends at the first branch. Only the copying path needs a write-ahead record,
   and there **the row and the pointer move go in one transaction** — a row that landed while
   live stayed on the previous version's object loses canonical content whichever of the two
   is purged next. Die during the copy and the key expires referenced by no one, and the sweep
   collects it: **that version never existed**. So "numbering" means the number going onto the
   row; the `v5` inside a copied key is a copy of what the row decided. Nothing reads a version
   number out of a key.

   **How the copy stopped being the default is open issue 10.** Every arrival used to copy the
   live object under a prefix of its own. The copy was historical rather than structural — live objects
   are as unchanging as version files, since every writer mints a new key and `promoteUpload`
   merely re-points, so the bytes a version promises are immutable where they already lie. Nor
   did anything depend on splitting hot from cold by prefix: the bucket has two lifecycle rules
   and neither looks at one. Implementing it rewrote the rule as ownership, and the copy now
   survives only where live does not move — an upload reusing its key, and a revert.

3. Add a `resource_version` table (managed by Drizzle):
   - `id` (UUID), `resource_id` (FK), `version` (sequential), `storage_key`, `size`,
     `hash`, `origin` (`upload` | `fetch`),
     `state` (`active` | `purging` | `purged`; ii-b drops `superseded`, §1.1),
     `created_by`, `created` / `updated`
   - Also associates a snapshot of the column schema (the version's equivalent of
     `metadata.schema`) and the Layer-2 snapshot ID (tabular only, see below). Under ii-b it
     also freezes **the key columns that ingest will use** (`lake_key_columns`) at creation
     time (spec §6.4)
4. **A replacement that is the same bytes read the same way does not create a version**: if
   **both the hash and the format** match the newest active version, issue no new version and
   only update a verification timestamp.

   > This originally read "if the hash matches". ADR-046 decision 3 defines a version as those
   > bytes _read under this interpretation_, so **a change of interpretation makes a version
   > even when the bytes do not change**. Format is the only interpretation condition settled
   > at creation time, and the gate compares it (ADR-046 §6).
   >
   > Assigning a primary key or column types is also a new version under decision 3, but
   > **neither exists yet at creation time**, so it arrives from a user action rather than
   > through the content gate (ADR-046 open issue 2, not built).

#### 1.1 How `state` moves

A version is made of two separate things.

|                    | What it is                 | Its job                                                                                             |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------- |
| **version record** | one `resource_version` row | what the version _is_ — number, state, hash, size, schema, format, and which object holds its bytes |
| **version file**   | the one object it owns     | the version's contents                                                                              |

**The only operation that destroys a version is a version purge, and even that destroys only
the file.** `state` lives on the record, so a purged version goes on answering who purged it,
when and why (a headstone). A revert destroys neither: it **adds** a version holding the
restored content.

**That invariant holds only for as long as the resource does.** Deleting a resource, or purging
its package or organization, takes the records with it via `ON DELETE CASCADE` on
`resource_version.resource_id`. A headstone answers "why did this version of this resource go",
not anything that outlives the resource itself.

A version record only ever comes into being through §1-2, and two things do it: the pipeline,
when a replacement or a fetch differs from the previous version, and the one-time migration
backfill, which gives a v1 to resources holding no version at all.

**The diagram below follows one version**, not the resource. v1 and v7 alike start at `active`,
and from there only a purge moves the `state`.

```
      this version was created (§1-2)
       │
       ▼
  ┌────────┐
  │ active │
  └────────┘
       │ purge requested (sysadmin only, reason required, audit logged)
       ▼
  ┌─────────┐
  │ purging │  a durable claim (ADR-028). The worker erases layers 1 and 3 and
  └─────────┘  the search index, and stands layer 2 down; a failure retries here
       │ every copy is gone and layer 2 is out of reach
       ▼
  ┌─────────┐
  │ purged  │  terminal. Only the row survives, as a headstone
  └─────────┘
```

There is no way back out of `purging`. A purge is a mechanism that does not give up partway;
made reversible, it could **report success with the version still obtainable**.

| State     | Live candidate | Version file | Layer-2 snapshot | Purgeable |
| --------- | :------------: | ------------ | ---------------- | :-------: |
| `active`  |      yes       | yes          | retained         |    yes    |
| `purging` |       no       | being erased | expired          |     —     |
| `purged`  |       no       | none         | null             |     —     |

- **Live is "the newest version that has not been purged".** That one sentence settles it, and
  no state exists to narrow the search
- **`purging` snapshots are not retained.** A purge calls the expiry from inside its own run,
  before it can set the row to `purged`; retaining a row mid-purge would **leave the purged
  version's files on disk** (§6-4)

> **ii-b dropped the fourth state, `superseded`.** A revert used to take every version above its
> destination out of `active`, so the diagram carried `active → superseded` and a way back from
> a failed restore. Once a revert **issues the destination's content as a new version** (§5),
> there is no set to narrow: `superseded` was never "a record that was rolled back" but **a
> working variable that made the search for "the newest active version" answer with the
> destination**.
>
> Reachability is unchanged. A version stepped down from live could always be downloaded (only
> `purged` is refused) and still appears in the version history; the state withheld only the
> "latest version" label and the restore destination. **"Must never be served again" is a purge,
> not a revert.** The contract side of this is ADR-044 §4.

### 2. External URL resources — observation-based versions

Version semantics differ between uploads and external URLs. A version of an external URL
resource is an observation — "**this is how it looked at fetch time**" — with no guarantee
of capturing every upstream change.

1. When the pipeline Fetch runs (manual reprocess; scheduled re-fetch in the future), store
   the content as `v{n}` in Layer 1 **only if its hash or its format differs** from the newest
   active version (the same gate as §1-4). If both match, only update the verification
   timestamp.
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
3. **DuckDB reads and writes storage directly** (httpfs / S3 API). An exception to the
   storage adapter, but **not because the API is S3-compatible** — that reasoning would
   cover `resources/` and `previews/` just as well, and the adapter would have no reason
   to exist. It is because **the adapter cannot express this way of reading**. `download`
   hands back a whole object as a `Readable`, where DuckDB reads a Parquet footer and then
   range-GETs only the row groups and columns it needs, across many files at once. Through
   the adapter that becomes whole-file downloads, which is the reason for using DuckLake
   gone. This does not loosen ADR-005's principle; it is **an exception forced by what the
   interface cannot say**.

   The scope is DuckLake's own `DATA_PATH` (the `lake/` prefix). `resources/` and `previews/`
   stay behind the adapter — Interpret too pulls the version file with
   `storage.download` and hands DuckDB a local path. What holds the boundary is the
   **module**, not the prefix: only `packages/lake` opens DuckDB (previous item).

   The price is **S3 connection settings derived twice**. DuckDB requires a secret of its
   own, so `packages/lake` re-derives from the same environment what `S3StorageAdapter`
   derives (endpoint, path style, SSL, static keys vs. credential chain). One truth, two
   derivations: change one and dev alone — or AWS alone — breaks (open issue 11).

4. **1 resource = 1 table**. Add a Version step to the pipeline and ingest the result of
   interpreting that version as column types. Start with the same targets as current
   Parquet generation: **CSV / TSV, ≤50MB** (raising the limit is an open issue).

   > This originally read the type inference Extract produced (ADR-029's own
   > implementation). ADR-046 collapsed interpretation into one stage (Interpret) and
   > moved type inference to DuckDB's sniffer.

5. **Snapshot mapping**: DuckLake snapshots increase monotonically catalog-wide, so record
   the snapshot ID obtained at each commit in `resource_version`, maintaining the
   "resource version ↔ DuckLake snapshot" mapping on the KUKAN side.
6. **Diff extraction uses a three-tier fallback**:
   - **With a primary key** → keyed ingest via `MERGE`, and a diff that **compares both
     endpoints by the key**. Added, deleted, and **changed** rows are distinguished, with
     minimal-cost history. The primary-key columns are optionally designated by an
     administrator in resource settings (v1 is manual only; AI-suggested candidates are a
     future extension of the ADR-040 suggestion infrastructure).

     > **The diff is not taken from `table_changes` (DuckLake's CDC).** That is an event log,
     > and "what happened" stops being "what differs" as soon as a range covers more than one
     > commit. Its start is inclusive, so even adjacent versions come out wrong, and over a
     > range a row that changes and changes back leaves both events uncancelled (measured:
     > 10000 reported against a true 100). Opening both ends with `AT (VERSION => …)` and
     > comparing is correct and also faster. Spec §7; ii-a's implementation has always worked
     > this way.

   - **Without a primary key** → whole-table replacement + statistical summary ("x rows added, y
     rows deleted out of N"). Row correspondence is judged only by exact row-content hash
     matches, and **"changed row count" is never reported** (without a primary key, changes
     cannot be distinguished from add+delete; do not fabricate change history from guesses).
   - **Schema change** (columns added/removed, type change) → abandon row diff; record a
     new version + the schema change.
7. **Column schema history (need 3)**: The DuckLake catalog retains column additions,
   deletions, and type changes with snapshot boundaries, so schema evolution of tabular
   resources is queryable with no extra implementation.
   `resource_pipeline.metadata.schema` remains the "latest version cache" as before.
   For non-tabular resources, Layer 1 (version, size, hash, timestamps) suffices as
   change history.

### 4. Exposure paths and sandbox separation

The ADR-032 sandbox is **preserved unchanged**. A throwaway DuckDB reads the Parquet in, and
**external access is shut off and the settings sealed once that read is done** — so all any
later user SQL can reach is the table already loaded. Nothing there gets to DuckLake
(ADR-032 §4).

On top of that, paths are separated by whether they may touch DuckLake:

| Path                                   | SQL origin                                                                           | DuckLake access                    |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| Version list / diff API (new)          | **Server-composed fixed queries only** (parameters limited to version numbers, etc.) | Yes                                |
| `/query` / `query_resource` (existing) | Raw SQL from users / AI                                                              | **No** (the above sandbox, intact) |

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

### 5. Purge

Makes a named version **unobtainable**. A mechanism for taking past content out of reach
(licensing issues, personal data, mistaken publication, etc.), independent of normal deletion
(resource delete).

> **ii-b narrowed what this section claims.** It was originally written as a mechanism to
> **destroy** past content, under the heading "Purge (legal deletion)". What happens to each
> layer has not changed, but **what can be claimed about layer 2 has**.
>
> - **Layer 1 (canonical), layer 3 (preview) and the search index are physically deleted** —
>   unchanged from the original
> - **Layer 2 has its `ducklake_snapshot_id` nulled, putting it out of reach of the product.
>   Erasure of the bytes is not guaranteed.** Expiry and `cleanup_old_files` **reclaim what
>   can be reclaimed**; they are not a means of erasure
> - **So no guarantee words: neither "legal deletion" nor "physically deleted".** The UI and
>   the audit log both state that rows may remain in layer 2. **Reporting "deleted" for
>   something that is still there is the one failure this section exists to prevent**
>
> Two reasons, and both are properties of the design rather than defects in DuckLake.
> **Snapshots belong to the whole catalog**, so a snapshot retained for another resource goes
> on holding this resource's files (§5.1's container principle, at catalog scale); and
> **keyed ingest writes rows individually**, so one file carries history rows and current rows
> together. The first is pinned by a test
> (`packages/lake/src/__tests__/purge.ducklake.test.ts`, "leaves one table's rows on the disk
> because another table needs the snapshots"). Details in spec §9.

1. **Restricted to sysadmin**. A reason is required and recorded in the audit log.
2. **Tombstone model**: The `resource_version` row remains (when, by whom, why purged);
   only the content is removed from all affected locations.
   Asynchronous transition `state: active → purging → purged` (following the ADR-028
   durable-claim pattern, executed by the worker).
3. **Affected locations**:
   - Layer 1: delete the object the version owns. One version, one object (ADR-046 §3), so
     nothing else is describing it. The delete comes first and the pointer is rolled back
     after: interrupted in between, live names an object that is gone rather than one that
     is not, which is the safe way round for a purge
   - Layer 2: **null the `ducklake_snapshot_id`**. Both the diff and time travel resolve a
     snapshot from the version row, so nulling it closes every path that has this version as
     an endpoint. Then expire the snapshots no surviving version names and call
     `cleanup_old_files` — **best-effort reclamation, and the purge completes whether or not
     it reaches anything** (what settles completion is the nulling). **No file is rewritten**
     (`rewrite_data_files` does not repoint retained snapshots, so it would leave both the old
     and the new file)

     > This originally read "expiry frees the file as a whole". That holds **for whole-table
     > replacement (ii-a)**, where a data file's lifetime coincides with a version boundary,
     > and it is still true within that range. Keyed ingest under ii-b breaks it (§5.1).

   - Derivatives: the preview Parquet derived from that version, **the text head** of its
     content (ADR-040), and the OpenSearch resource-content index (ADR-021, when the purged
     version is the latest). The text head is named by a pointer inside `metadata`, so the
     orphan sweep never collects it — a purge that does not destroy it leaves an extract of
     the content in the bucket, readable through the suggestion path
4. **Physical destruction timeline** (AWS): On purge, the content becomes immediately
   invisible to the app layer (all roles). S3 noncurrent versions expire via lifecycle
   (30 days, ADR-037), and AWS Backup recovery points disappear when their retention
   expires. **State explicitly in the spec: "after a purge, physical destruction completes
   within at most 30 days plus the backup retention period."**

   > **This timeline describes layers 1 and 3 only.** It is about when the noncurrent versions
   > of a deleted **object** expire, and layer 2 was never deleted, so it is not at the door.
   > Rows left in layer 2's Parquet have no deadline.
   > During the residual window, no code path in the app reaches noncurrent versions — no
   > KUKAN role can access them (only infrastructure operators holding AWS IAM can).
   > On-prem (MinIO without versioning), deletion is immediate and no residue exists (note
   > that backup handling depends on the deploying organization's operations).

**A purge can only destroy the copy its own version holds.** A version is settled from its
bytes _and_ the reading they are settled under (ADR-046 §3/§6), so correcting the format
label of content that did not move leaves the same bytes present as two objects, one owned
by each version. Sharing a single object between two versions would let a purge of either
carry off the other's content — that is why the key differs per write (ADR-045). The price
is that **purged content can stay retrievable under another version number.**

Whether those versions should go too is a judgement about a separate canonical record, so
nothing destroys them automatically. What was missing was not a deletion mechanism but the
information the decision needs, so **the purge confirmation dialog names the other versions
holding the same content.** It names the ones that survive — `active` and `superseded`: a tombstone
holds no content, and a version already `purging` is being destroyed as well, so offering it as a
survivor would send the operator after a second purge the resource refuses while the first
is in flight. `superseded` counts because a version a revert stepped off still holds its content.

**That notice depends on the version list being complete.** Sameness is decided by comparing
the `hash` the list already returns for each version, so it costs no extra query and no
index. Paginating the list means moving the decision to the server (open issue 13).

**Layer 2's current contents follow the newest successfully ingested version.** Both a purge
and a revert (ADR-044 §4) move the table's current contents there. What differs is only what
happens to the _version_ — a purge makes it unobtainable, a revert issues its content as a new
version — not where the table's current contents point.

> **Not "the live version", and layer 1 and layer 2 fall back to different places.**
>
> |                            | Falls back to                                                        |
> | -------------------------- | -------------------------------------------------------------------- |
> | Layer 1 (the live pointer) | the newest version that has not been purged                          |
> | Layer 2                    | the newest **`active`** version **that has a snapshot and resolves** |
>
> A live version need not be in layer 2: one too large, one that is not tabular, and under
> ii-b one whose primary key is invalid all stay without a snapshot while being live. **Stand
> layer 2 down using layer 1's destination and it reads as "nowhere to go" and drops the
> table** (spec §9.1 has the v1/v2/v3 case). Recovery keys off the same definition
> (spec §11-5).
>
> **A `superseded` version is readable, but not somewhere to stand.** A reclaim's retained set
> keeps their snapshots so their diffs still read (`lake-reclaim.ts`), but putting their rows
> back as the contents is restoring rows the resource stepped off — the very thing
> `standOnBase` and the revert's reconcile undo.
>
> **With no `active` target left, only a purge drops the table.** A purge owes unfetchability, and
> **a `DROP` costs the current contents only — the retained snapshots stay readable through it**
> (measured; pinned in `maintenance.ducklake.test.ts`). A revert in the same state does not drop,
> because it owes nothing of the kind; that line is drawn under "a revert that empties the
> resource" above.

> **ii-b changed _how_ they move.** The original read "roll the table back to that snapshot,
> and record the snapshot it lands on against the destination version". That means
> **overwriting the version row's `ducklake_snapshot_id`**.
>
> **The original reason was that this made the diff silently return nothing. It no longer
> holds** — the diff compares endpoints rather than reading `table_changes`, and comparing
> endpoints does not depend on snapshot order (measured in spec §7.2). Two reasons remain, and
> **both are weaker than the one they replace**: `CREATE OR REPLACE` is the whole-rewrite path
> §6-2 rejected, and dropping `superseded` is independently justified by ADR-044 open issue 7.
>
> With that said:
>
> - **A version row's `ducklake_snapshot_id` is written once.** Nothing overwrites it
> - **Operations that move contents go through the ingest path** (never `CREATE OR REPLACE`),
>   and where they land is not written back — the same holds for a purge standing the table
>   down, whose landing snapshot is named by no version row at all ("always keep the newest
>   snapshot", §6-4, already covers that case)
> - **A revert does not restore, it re-issues.** It creates a new version holding the
>   destination's content, so snapshots are handed out in publication order and the two orders
>   cannot diverge
>
> As a side effect, a diff spanning a revert becomes a real row diff. Moved with
> `CREATE OR REPLACE`, the change feed saw every row as an insert.

The original decision was the opposite: that layer 2 follows the newest version ingested
rather than the live content, and so may keep the retracted version's rows after a revert.
**ii-b overturns that.** The `MERGE` targets the table's current contents themselves, so
without following through the merge base is a retracted version (open issue 7). What made
this harmless under ii-a was not that every ingest replaces every row, but that its only
reader — the diff — never looks at the current contents (it resolves both sides to their own
snapshots). That is a property of having one reader, not a guarantee.

Following through happens **as the ingest of a new version**. A revert issues a version
holding the destination's content, that version goes through the Lake step like any other, and
the table's current contents move with it. If the ingest fails, the version stays outstanding
and **the sweep picks it up and retries**. The sweep's listing and the ingest's own ordering
check **must carry the same condition**: relaxing one alone produces a version queued every
hour and refused every time.

> The original had two paths: roll back to the destination's snapshot if it had reached the
> lake, and leave it to the sweep if it had not. Advancing the version collapses them into
> one — there is no need to ask whether the destination was ingested, because **an issued
> version is always outstanding**.

**An ingest applies to a table standing on the previous active version.** ii-a survives
without this — every branch writes every row, so the contents land right whatever was there
before — but the decision it makes on the way, "did the columns move?", is read off whatever
the table happens to hold, and after a revert that is a version the resource stepped off.
ii-b's `MERGE` takes those same contents as its base, so the answer stops being cosmetic.
So **before an ingest, if the table stands ahead of its base, it is put back on it** — which
also repairs a revert whose own reconcile could not run.

The first sketch was to resolve only the _comparison_ from the base's snapshot. That does not
work: the write side (`DELETE` + `INSERT`) still runs against the table's current columns, so
a head that disagrees with the base fails the insert. What has to move is the head, not the
comparison.

**The snapshot it lands on is not written back to a version row.** The original recorded a
rollback's landing snapshot against the destination version, which runs straight into the
write-once rule above. **The check works without it**: if a revert issues a version, whether
the table stands in the right place is answered by "is the newest version ingested?", and that
version's snapshot was written once, at issue. Writing back was only needed because contents
moved without the version numbers moving with them.

**A revert that empties the resource does not drop the table.** With nothing live, no reader
resolves to the table's current contents, and a revert carries **no obligation to make anything
unfetchable** — the versions it stepped down from live are not `purged`, so their contents may
still be read through a diff. To destroy a version's contents too, purge it: that is the rung
above on the ladder.

> **Not because it cannot.** The original reason was that dropping the table would take the
> stepped-off versions' diffs with it, but **a `DROP` does not cost the retained snapshots their
> readability** (measured; spec §9.1). It is not dropped because nothing requires it, not because
> it could not be. **ii-b gains one premise from this**: the head after an emptying revert still
> holds retracted rows, so its `MERGE` needs the rule "with no base, start from empty"
> (spec §14.1-16).

#### 5.1 The container principle

**DuckLake cannot delete a row. It deletes files.** A purge can claim to have erased a
version's rows only when those rows fill a file exactly, with no other version's rows in it.

Call that unit — the thing that can only be discarded whole — the **container**. It is one
Parquet data file (enable inlining and the catalog's inlined table becomes one too, but that
is turned off — §6-1).

Whether a purge is cheap comes down to one thing: **do several versions' rows sit in the
same container?** If they do not, expiring that version's container and running cleanup is
the whole job. If they do, the container can only be discarded whole, so **every surviving
version that was inside it has to be rebuilt from Layer 1**.

> Confusingly, **a row appearing in two versions is not itself the problem**. A row unchanged
> between v1 and v2 is current data, and purging v1 does not delete it (must not). The problem
> is that rows to delete and rows to keep are **in the same file**.

Three conditions put them together.

| What makes it shared                                             | How far it reaches              |
| ---------------------------------------------------------------- | ------------------------------- |
| Delta writes mix history-only and current rows                   | Between one resource's versions |
| Compaction merges across versions (§6-2)                         | Between one resource's versions |
| **A retained snapshot of another table falls inside a lifetime** | **The whole catalog**           |

**Turning the inlined table off is exactly because it reaches the widest** (§6-1): with it on,
neither expiry nor cleanup reaches an inlined row, and the only way to reclaim one is
`DROP TABLE`.

**Whole-table replacement is the one shape that shares no container** — which is why ii-a's
purge costs nothing but expiry plus cleanup, and **ii-b loses that exception**.

> **The third row is what settled it.** The table originally carried only the first two, and
> the cost was written as "rebuild from layer 1" (every merged version, or everything from the
> purged version onward). With the third row, **that rebuild does not work** — it writes new
> files, while what holds the old ones is another resource's retained snapshot. The
> measurement behind "only a full rebuild succeeds" was taken **in a catalog of one table**,
> and does not hold for the catalog shape production has (spec §9.2). **The container
> principle operates at catalog scale, and no procedure erases one resource's bytes.**

**Whether a version has a key is per-version state, not a phase.** A primary key can be
set later and removed again, so a single resource's history can mix versions ingested
without a key and versions ingested with one. Whole-table replacement is therefore treated
as the **degenerate case of a primary-keyed diff**. Whether a given version shares a container
is derivable from the lifetimes in `ducklake_data_file`, so no extra application state is
needed.

That every version is a whole-table replacement today is only because there is no
primary-key selection UI yet. Once primary keys can be specified, both shapes appear in the
same catalog — and that is also where consolidating for read performance starts competing with
keeping purges cheap. **That competition is over now that a purge no longer claims to erase
bytes: consolidate freely (§6-2).**

### 6. Operations — data inlining, compaction, snapshot retention

1. **Data inlining is disabled** (`data_inlining_row_limit = 0`). By default DuckLake
   keeps small tables (measured: 10 rows or fewer) in the catalog rather than in Parquet.

   This is **a write buffer for small, frequent writes**. Producing a Parquet file per
   few-row commit piles up small files, and readers pay metadata resolution per file (the
   classic weakness of Iceberg / Delta). Write no file and the problem does not arise; the
   round trip to object storage is saved too, and the write fits in one database
   transaction — DuckLake's advantage of putting the catalog in a SQL database, pushed all
   the way to the data itself. Accumulated rows are meant to be written out later by
   `ducklake_flush_inlined_data`; the target is streaming ingest and row-at-a-time
   INSERT / UPDATE.

   **KUKAN has no such workload.** Its writes are one whole-table replacement per version —
   neither small nor frequent. None of what inlining is for applies, so there is next to no
   benefit and only the costs below.
   The representation itself carries `begin_snapshot` / `end_snapshot` per row, so it
   **could in principle be reclaimed at a finer granularity than files**. The problem is
   that the implementation does not do so:
   - **Inlined rows are never reclaimed.** Once every snapshot that could observe a row is
     expired, it is unreachable through DuckLake yet still sits in PostgreSQL, and neither
     `expire_snapshots` nor `cleanup_old_files` removes it. (The documentation says inlined
     data differs from Parquet only in where it lives; on this point it behaves differently.)
   - `ducklake_flush_inlined_data` is not a workaround. It does write the rows out, but
     because it materializes the inlined MVCC table as-is, **all versions' rows land in a
     single file**. Surviving versions reference that file, so the purged rows still cannot
     be deleted.
   - Without inlining, whole-table replacement gives each version its own file with
     a disjoint lifetime, so expiry frees the file as a whole.

   **Flushing never happens on its own.** The limit is judged per write — the official
   description is _"Maximum amount of rows to inline in a single insert"_ — so it does not
   accumulate. For a caller using it as a buffer, a small single insert is the premise, so
   that much is as intended — but **nothing stops the pile from growing**. And
   `auto_compact` is not a scheduler (it only decides whether a table is
   included when a maintenance function is called without a table argument). Measured: 15
   single-row INSERTs followed by 15 single-row UPDATEs produced no Parquet at all and left
   30 inlined rows for 15 live ones.

   Structurally, an inlined table is always in the same state as a compacted file, so §5.1's
   container principle applies directly (container = the table, cost = rebuilding every
   version). Enabling inlining therefore costs ii-b the "leave earlier versions untouched"
   optimisation.

   This is therefore a workaround for **an implementation gap that shows only when the
   feature is used outside what it is for**, not a judgement about the representation. **If upstream implements reclamation of inlined rows on expiry, this
   decision can be revisited.** The setting is persisted on the catalog; an ATTACH option
   would bind only that session, leaving the guarantee dependent on who opened the
   connection.

2. **Whether compaction is needed follows from the write shape** (this too is not a
   property of a phase). Under whole-table replacement the live data files are just one
   version's output and **do not grow with the number of versions**; a diff always reads
   two versions' worth, so the cost is flat however many versions exist (measured across 21
   versions: v1→v20 costs the same as v19→v20). With nothing to consolidate,
   `ducklake_merge_adjacent_files` does nothing and returns `[]`.

   Once a resource starts receiving primary-keyed deltas, live files accumulate per version and
   compaction becomes effective (measured: 501 files → 1, 3.9× faster scan; it runs with
   every version retained and time travel intact).

   **ii-b therefore runs `ducklake_merge_adjacent_files` at the end of each ingest.** It fires
   on the live file count, default threshold 50. A resource that only ever sees whole-table
   replacements has nothing to consolidate and the function does nothing, so no branch is
   needed either. **`ducklake_rewrite_data_files` is not used** (it does not repoint retained
   snapshots, so it would leave both the old and the new file).

   > **This originally read "there is a tension with purging"** — merging across versions
   > creates a §5.1 container, so a purge would drag in the surviving versions sharing it.
   > **That tension is gone.** Once a purge stops claiming to erase layer 2's bytes (§5),
   > consolidating takes nothing away. Threshold and measurements in spec §11-2.1.

3. **Snapshot / version retention count**: Held as a runtime system setting (ADR-036),
   changeable by sysadmin (default unlimited; expected operation is to tighten it when
   storage pressure rises). Expiring old snapshots runs in the same maintenance job.

   > **Not implemented.** The default is unlimited, so not building it behaves identically to
   > leaving it at its default, and nothing forced the issue. **No version is therefore ever
   > dropped by generation count today** — version files go in exactly three ways: a version
   > purge, a package or organization purge, and the orphan sweep collecting abandoned
   > attempts. The snapshot expiry in 4 below is unrelated to any retention count; it turns
   > only on whether a surviving version still references the snapshot.

4. **Expiry uses an explicit list** (`versions => [...]`).

   > **Expiry and purging are different things.** Expiry is **housekeeping** that drops
   > DuckLake snapshots from the catalog — layer 2 only, and it deletes no file itself (it
   > merely takes the references to zero; `cleanup_old_files` does the deleting). A purge is
   > KUKAN's operation for erasing a version's content everywhere it reached (§5), and it
   > calls expiry as one of its steps (§5-3). **Expiry is the tool; the purge is the
   > intent.** As housekeeping, expiry only drops snapshots no surviving version references,
   > so on its own it loses no content at all.

   The candidates are every snapshot minus those referenced by a **version that has not been
   purged** (`state` of `active`) minus the newest snapshot. A time-based `older_than` cannot
   be used — the ids are one catalog-wide sequence, so an age cutoff sweeps up snapshots
   belonging to resources that simply have not changed. The newest is always kept because a
   purge that stood a table down onto layer 2's rollback target has just created one that
   no version record points at yet.

   **The set is "versions not purged", not "current versions".** A diff resolves both endpoints
   to their snapshots, so dropping a version that is no longer current breaks the comparison.
   `purging` is excluded alongside `purged`: a version purge calls this from inside its own
   run, before it can set the row to `purged` (that write also nulls the snapshot), so
   retaining a row mid-purge would leave **the purged version's files on disk**.

   > This set was originally `active` **or `superseded`**. Dropping `superseded` (§5) leaves
   > `active` alone, but **the meaning has not changed** — the state was listed to keep "the
   > snapshot of a version a revert stepped off", and once a revert stops stepping versions
   > off, that version is simply still `active`.

5. **Orphaned files**: DuckLake writes Parquet before committing to the catalog, so a
   crash in between leaves untracked files under `lake/`. Neither expiry nor cleanup
   covers them (that is `ducklake_delete_orphaned_files`' job). This is a storage leak,
   not a correctness problem.

6. **A deferred ingest naming the Parquet it needs (`resource_version.lake_source_key`) —
   retired (ADR-046 §4).**

   Layer 2 reads the version file directly now and a retry re-runs the interpretation, so
   **no temporary pointer is created in the first place**. The column and the whole lifecycle
   it required — defer, park, reference check, hourly sweep — went together (added in
   migration 0027, dropped in 0028).

   > **What it solved** (kept as a record). A failed ingest stays queued as a retry, but a
   > queue message is **a reference the orphan sweep cannot see**: the run that replaced the
   > preview parked it, the sweep took it, and that version could never enter layer 2. The
   > column let a version declare "I still need this", making it the sixth source the sweep's
   > reference check reads (ADR-045 §3). No clock was involved, so nothing was lost to a
   > dead-lettered message — and the queue message stopped being the only record.
   >
   > The price was that all three paths dropping the pointer — the ingest lands, a newer
   > version overtakes it for good, the object is gone — **had to park the key in the same
   > statement that dropped it**. While a version named a key the sweep read it as referenced
   > and removed the ledger record instead, so dropping without parking left an object with
   > neither (the caveat in ADR-045 §3).

## Consequences

- **DB**: Adds the `resource_version` table (Drizzle). A DuckLake catalog schema is added
  inside the same PostgreSQL (managed by the DuckLake extension, outside Drizzle)
- **Worker**: Adds a Version step to the pipeline (Layer-1 storage, hash gate, DuckLake
  ingest, diff extraction). Adds maintenance jobs for compaction / expiry / purge
  execution. `@duckdb/node-api` becomes a worker dependency as well
- **API**: Adds routes and services for version listing, diff, and purge. Extends the
  existing `/query` with a `version` parameter. No DuckLake write path is added to the
  web process
- **Storage**: layer 1 grows by one object per version, the object each one owns — no
  duplicate of the live file, since a version names it (controlled by the retention setting).
  `lake/` grows at diff cost (unchanged files are physically shared between versions)
- **Security**: SQL touching DuckLake is server-composed only. The ADR-032 sandbox is
  unchanged. Purge is sysadmin-only + audit-logged
- **Backward compatibility**: Existing resources get v1 at their next replacement. Existing
  download / preview paths are unchanged

  > This originally said "existing resources are not filled in in bulk" (the same policy as
  > ADR-029 / ADR-032), but **a one-time migration was built**. Waiting for the next replacement
  > means every resource replaced before then **is overwritten with nothing of its old content
  > in layer 1** — versioning would fail exactly the content most likely to be lost right
  > after it ships. It runs from the admin screen, naming the current file of every
  > version-less resource as its v1 — nothing owns it yet, so nothing is copied — and takes
  > the execution claim (ADR-044 §1).

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
6. **AI primary-key suggestion**: Add primary-key candidate suggestion to the ADR-040
   suggestion infrastructure to help resources graduate to primary-keyed diffs (the MERGE
   tier)
7. ~~**The ii-b purge mechanism (a prerequisite for graduating)**~~: **Settled 2026-08-17 (not
   built).** Moving to primary-keyed diffs makes §5.1's container principle lose its ii-a
   exception and apply always. **The answer was not to build a finer-grained purge but to
   change what a purge claims** (§5) — layers 1 and 3 and the search index are physically
   deleted, and layer 2 is put out of reach.
   - The finer-grained purge that was considered (**roll back to the version before the purged
     one and re-ingest only the versions after it from layer 1**) does not work. Containers are
     shared at catalog scale, so re-ingesting writes new files while another resource's
     retained snapshot goes on holding the old ones (§5.1).
   - `ducklake_rewrite_data_files` is not the answer either: it writes a new file but does not
     re-point retained snapshots, so the old file survives. **Not used.**
   - The tension with compaction is gone too. With no claim to erase bytes, consolidating is
     free (§6-2).
   - The change in semantics stands: a row written by the purged version is **not** erased if a
     later version still carries it, because that is current data. UI wording has to reflect
     this.
   - So that one version does not span several DuckLake snapshots, keyed ingest's two
     statements share one transaction (**one version, one snapshot**; spec §11-2.4).
   - DuckLake supports no PRIMARY KEY / UNIQUE constraint; the primary key is a logical one
     used in the MERGE condition.
   - ~~**A revert does not follow through to layer 2.**~~ **Resolved** (§5). A revert issues
     the destination's content as a new version, and that version follows through by going
     through the ordinary ingest.
   - For the same reason, ingest deciding "did the columns move?" **against the table's
     current contents** does not hold under ii-b. ii-a survives only because both branches
     write every row, so a wrongly chosen branch still lands correct contents — the basis for
     the choice is already wrong after a revert. The base is resolved from the newest version
     rather than from current contents.

   The remaining decisions and measurements are in
   `docs/specs/en/phase-versioning-2-ducklake.md` §0.

8. **IAM hardening**: Explicitly deny `s3:GetObjectVersion` / `s3:DeleteObjectVersion` on
   task roles so that noncurrent versions during the purge residual window are blocked at
   the IAM level too (currently blocked only by the absence of code paths)
9. **Iceberg export**: Provide public snapshots in Iceberg format (direct reads from
   external engines). DuckLake's Iceberg-compatible delete vectors keep conversion cost
   limited
10. ~~**Make live a link to a version**~~ (§1-2): **done**. The write-ahead record and the copy
    dropped out of creating a version on the ordinary path, leaving it one statement. They
    remain where the object is already owned. Two things the implementation settled.
    - **Immutability is not a reason** — live objects do not change either (§1-2)
    - **Purge argued for sharing, not against it** — a version and its live copy went in one
      operation even then (delete the version file, book the old live key for reclamation),
      and one object is one fewer thing to forget. A failed rollback would leave live pointing at a
      deleted object — unservable, which is the safe direction for a purge
    - **"One version, one object" survives, but the rule had to be rewritten** — "each holds
      the key it had while it was live, so they never share" **did not hold**. Live does not
      always move: an upload keeps its key across runs, and a revert puts live back onto a
      version's object, so changing the interpretation there files two versions against one
      file. Stated as ownership rather than as a cause it is uniform again — **a version takes
      an object nothing owns, and copies one that is already owned.** The copy survives on
      that one path and is gone from the ordinary one, where content changes

    - **The revert's two steps cannot be collapsed separately.** With the copy gone there is no
      seam left between `stepOffAbove` and the publish for a test to fail, so the rollback
      path becomes code nothing can exercise. It was collapsed in the same change — by a
      **transaction**, not by merging the SQL: both are database writes now, which is enough,
      and it leaves `publishLiveContent`'s reclamation rules in one place
    - **The reclamation predicate cannot land first.** Live keys were `resources/` and version
      keys a prefix of their own, so before the link the predicate never fires once

    Of the costs in §1-2, two applied: two kinds of referent, and one predicate on reclamation
    booking. **The first was later retired** — the copy now takes a key of the same shape as
    live, so live has one kind of referent again. The version-only prefix was left holding
    the copy path alone, a name denying where version files actually are, and a key can only
    carry where an object belongs and which write produced it — what it _is_ is not settled
    when it is written. "Cleanup after an unchanged re-fetch" belongs to moving the publish, which is
    separate (open issue 12)

11. **S3 connection settings are derived in two places** (§3-3): DuckDB requires a secret of
    its own, so `S3StorageAdapter` and `packages/lake` each derive their settings from the
    same environment, independently. Change one and only one environment breaks — and only on
    the lake path, which is where it is least likely to be noticed. One function deriving
    them, read by both the adapter and DuckDB, is the straightforward form
12. **Move the publish behind version creation** (§1-2): open issue 10 made live a link, but
    Fetch still publishes **before** the version exists. Reordering removes three of the
    "live with no version" rows in §1-2's table (just after a revert, an unchanged re-fetch,
    and what a killed run leaves behind). The price is cleanup after an unchanged re-fetch:
    Fetch writes a fresh key every time, so a key that did not become a version has to be
    dropped or the saving is spent. **Independent of the link**, which is why it is separate
13. **Paginating the version list means moving the same-content notice with it** (§5): the
    purge dialog can name the versions holding the same content because the list returns all
    of them. Once there are enough versions to paginate, the page holds only part of the
    resource's history and a twin on another page goes unnamed. The decision then belongs on
    the server, with an index on resource and hash. **A miss is silent — the dialog simply
    says there are no others** — and it surfaces as a failed purge, so whoever adds
    the pagination moves the notice too

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
- ADR-040: AI metadata suggestion (future extension for primary-key column candidates)
- ADR-041: Multi-site deployment (open issue on catalog partitioning)
