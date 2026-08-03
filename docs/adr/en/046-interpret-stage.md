# ADR-046: Separating the canonical copy from its interpretation

## Status

**Accepted** — implemented 2026-08-01

Make the canonical copy (layer 1) durable **before** anything interprets it. Fold type
inference, Parquet generation and the DuckLake ingest into one re-runnable stage, on DuckDB.
Define a version as "these bytes, read under this interpretation" — so changing the
interpretation makes a new version.

Collects ADR-043's open issue "unifying the preview Parquet (layer 3)".

## Context

### 1. The write we least want to lose sits behind the step most likely to die

The order today is Fetch → Extract → Version → Lake → Index. Version — the canonical copy,
layer 1 — comes after Extract for one reason: **so the column schema Extract produces can be
burned onto the version record**.

But Extract is the heaviest step in the run. For CSV/TSV, with the input capped at 50MB:

```ts
const text = bufferToUtf8(fileBuffer, encoding) // a UTF-8 string
Papa.parse(text) // every row, as string[][]
buildColumns(headers, dataRows) // typed column data
parquetWriteBuffer({ columnData }) // the Parquet buffer
```

Several times the input, live on the JS heap. The input size is capped; what it expands to is
not.

**And that death is deterministic.** The same file allocates the same way every time, so an
SQS redelivery dies in the same place. At `maxReceiveCount` it goes to the DLQ, and **that
content never enters layer 1 at all**. Redelivery only rescues transient failures.

Layer 1 is the one asset that cannot be regenerated, and it is the same for every format.
Losing it **because a derivative failed to generate** is an accident of ordering, not a
necessity.

### 2. The preview Parquet is layer 2's only bridge

Layer 2 (DuckLake) can only ingest from the preview Parquet, because that is the only copy of
the version's bytes in a form it can read. So a version whose ingest failed has to keep
naming that preview (`resource_version.lake_source_key`, ADR-043 §6-6).

That one pointer is why all of this exists:

- set the pointer when an ingest is deferred, parking the key it displaces in the same statement
- swap pointer and snapshot id together when the ingest lands
- drop the pointer and park it when an overtake refuses the version for good
- add the column to the orphan sweep's reference check
- guard against setting it on a version already ingested or purged
- sweep hourly for what the queue dropped

**If layer 2 could read the version file, none of it would be needed.** The version file is
immutable and named by `resource_version.storage_key`, so a retry can always read it again.
There is no temporary pointer to keep alive.

### 3. A mutable judgement is sitting on an immutable row

`resource_version.schema` is burned in at capture time. But if users are to assign a primary
key or custom types, **the schema is not settled at capture** — they have not chosen yet.

Making the assignment changeable puts a mutable value on an immutable row. Either changing a
primary key makes a new version, or immutability breaks. **Which one is right depends on what
a version is**, and not having answered that is the real problem.

## Options considered

### A) Leave it

- **For**: no change; the schema is written in one insert
- **Against**: all three problems remain, and the primary-key UI cannot be built

### B) Move Version earlier, nothing else

Fetch → Version → Extract → Lake → Index, with the schema attached by an UPDATE after Extract.

- **For**: small, and it fixes the durability problem
- **Against**: dying between the insert and the update leaves a version record whose schema is
  **null for good** — the content has not changed, so no later run captures it, and nothing
  attaches a schema to an existing row. That means another repair pass. The preview dependency
  and the burn-in problem both remain

### C) One interpretation stage, on DuckDB

Fetch → Version → Interpret → Index, where Interpret does type inference, Parquet generation
and the layer 2 ingest in one stage, on DuckDB.

- **For**: the OOM path disappears (`COPY (SELECT * FROM read_csv(...)) TO ... (FORMAT
parquet)` streams). Layer 2 reads the version file, so the preview dependency goes. The stage
  is re-runnable, so changing a primary key re-runs **only that**
- **Against**: type inference moves from ADR-029's own implementation to DuckDB's sniffer. And
  since `read_csv` has **no way to read a Japanese CSV correctly**, encoding detection and the
  UTF-8 conversion stay in front of it (§5)

## Decision

**C**, together with a definition of what a version is.

```
Fetch ─→ Version ─────────────→ Interpret ──────────────→ Index
        layer 1, all formats    infer → Parquet → layer 2
        bytes only              (two sessions, see below)
                                ↑ re-run this alone on a key/type change
```

### 1. Layer 1 carries no interpretation

Version runs right after Fetch, as the lightest work there is — a server-side copy and an
insert. It is the same for every format and does not care whether the content is tabular.

Kills are unaffected. The version insert is conditioned on the claim (ADR-044 §4), so a
stopped run leaves no version whatever the order. **The claim decides that, not the ordering.**

### 2. Interpretation is one re-runnable stage

Inference, Parquet and the ingest read the same input — the version file — in one stage. All
three share one interpretation by construction, and since the input is immutable, a failure can
be retried any number of times.

**The sessions are split, though.** The DuckLake ingest runs under the catalog-wide advisory
lock: the snapshot it commits is read back as the catalog-wide maximum, which only identifies
that commit while writes are serialized. Done in a single session, the lock would be held for
the whole interpretation — hundreds of milliseconds to seconds — and every other ingest would
wait it out.

```
outside the lock  version file → temp file → detect/convert to UTF-8 → inference → local Parquet
inside the lock   read_parquet('<local Parquet>') → DuckLake
```

**What the locked section reads is a local file, not the preview in storage.** That is the
premise of §4: the temporary pointer stops needing to be protected because of this split.

The interpreting DuckDB instance stays open until the interpretation returns — the `COPY` is
followed by a pass for each column's null count, distinct count and bounds. It does not overlap
with the ingest's session because the table is handed over after that, not before. And that is
about the _interpreting_ instance only: the DuckLake one is cached per process (ADR-043, so the
catalog ATTACH and the extension loads are paid once) and stays resident from the first ingest
onwards. What survives
the wait on the lock is the Parquet alone — the source CSV and its transcoded copy are dropped
as soon as the interpretation is done with them.

**The unit of re-running becomes the interpretation.** Retrying a failed ingest and changing a
primary key both run this stage alone, without Fetch. The first adds no version, the second
does (below) — what differs is not the input but whether the interpretation changed.

### 3. Changing the interpretation makes a new version

A version is not "those bytes" but **"those bytes, read under this interpretation"**.
Assigning a different primary key or type creates a version; it never rewrites an existing row.

That dissolves the mutable-judgement problem — **nothing mutates**. The history of
interpretation changes lands in the version history, so who changed what and when is visible
there as well as in the audit log, and no new home is needed outside the version record.

The schema still is not settled at capture, so the write to the version record happens after
Interpret. B's drawback is not one here: **unassigned is a normal state**, with a path in the
UI to fill it.

**The bytes are copied.** A version that differs only in interpretation still gets a version
file of its own. Sharing one object between two versions would avoid the copy, but **one
version = one object is an invariant the purge depends on**. Shared, purging v2 either
destroys v3's bytes or fails to destroy anything — a legal deletion that does not delete. A
50MB copy is cheap against that.

Two consequences. **The content gate sees only the interpretation conditions settled at
capture**: `decideVersionCreate` compares the latest active version's hash _and_ format (§6).
A corrected format therefore makes a version, while a key or type assignment — which does not
exist at capture — arrives through a user action rather than the pipeline (open issue 2). And
**several versions sharing a hash becomes normal**; the places that look a version up by hash
(a revert's starting point, the version awaiting ingest) take the newest match and stay
correct.

### 4. `lake_source_key` is retired

Once layer 2 reads the version file, everything in context 2 goes. A version awaiting ingest
is simply "active, with no snapshot id", and **that alone settles whether it is outstanding**.
The hourly sweep looks for exactly that.

What else the sweep applies is not part of the condition but a filter against queueing work that
cannot succeed: formats and sizes an interpretation makes no table from, and versions a newer one
has overtaken (which the ingest refuses anyway). Without it, every PDF version stays outstanding
for good and is re-enqueued hourly.

### 5. Encoding stays in front

`Encoding.detect()` and the UTF-8 conversion stay in front, and the converted object is what
Interpret reads. Handling Japanese CSVs is not negotiable.

Letting DuckDB read them was measured and rejected. Adding the core `encodings` extension
(57MB to distribute, the same channel as the four the Dockerfile already installs) makes it
accept Japanese encoding names, but **not one of those names reads a Japanese municipal CSV
correctly** (measured on DuckDB 1.5.4).

| Name                              | CP932 extensions (`㈱` `①` `髙`) | ASCII                                 |
| --------------------------------- | -------------------------------- | ------------------------------------- |
| `shift_jis`                       | **fails the whole file**         | nearly right (`\`→`¥`, `~`→`‾`)       |
| `windows-932-2000`                | reads them correctly             | **29 of 93 characters are corrupted** |
| `cp932` / `windows-31j` / `ms932` | name not supported at all        | —                                     |

`shift_jis` is strict JIS X 0208, so a single `㈱` — routine in a CSV exported from Excel —
fails the entire read (`ignore_errors=true` drops that whole row instead, which is a silent
loss). The wave dash `～` comes back as `〜`.

`windows-932-2000`, the one name that reads CP932, has a broken single-byte range: `1`→`¹`,
`3`→`³`, `A`→`Æ`, `s`→`ß`. **ASCII, digits included, is silently replaced** — `"1000"` becomes
`"¹000"` and the column degrades from BIGINT to VARCHAR. It looks like the same root cause as
[duckdb/duckdb-encodings#10](https://github.com/duckdb/duckdb-encodings/issues/10).

It also loses on speed. For 16.7MB of CP932 across 400,000 rows: reading it directly takes
1247ms, against 88ms to convert in front plus 231ms to read the UTF-8 = 319ms. **Direct is
3.9× slower.**

`TextDecoder('shift_jis')` — the WHATWG label, which is Windows-31J in practice — gets every
case right. **This is worth revisiting if upstream fixes it**, but today converting in front is
both more accurate and faster. Detection (`chardet`) has to stay in front either way: DuckDB
has to be told `encoding=`, it does not detect.

### 6. Interpretation conditions settled at capture live on the version record

Once decision 3 defines a version as "these bytes, read this way", **the definition does not hold
unless the interpretation conditions are on the version record**. Format is the first of them: change
the delimiter and you have a different table, so format is a display label and an interpretation
condition at once.

`resource_version.format` holds a copy of `resource.format` taken at capture. Interpret and the
layer-2 pending check both read the version's. A reader that consults the current label
**interprets settled bytes by a rule they were never read with, and rewrites the schema of versions
that have not changed** — the mutation decision 3 forbade, coming back in through a missing column.

`resource.format` stays, because **the two answer different questions**.

|                                              | Reads                     | Question                      |
| -------------------------------------------- | ------------------------- | ----------------------------- |
| Badge, facets, search index                  | `resource.format`         | What is this resource now     |
| Interpret's branching, layer-2 pending check | `resource_version.format` | What were these bytes read as |

**They cannot be forced to agree.** They always agree right after a capture, and diverge only when
a user changes the label. Forcing them would mean either discarding the edit silently or
re-interpreting a settled version — and the second is exactly what this section forbids.

**The divergence carries meaning**: the label moved and this content has not been re-interpreted
under it. That is the trigger condition for open issue 2, so it is something to build on rather
than something to erase.

Changing a format is not forbidden. A URL with no extension, a `.txt` that holds TSV, dirty values
in migrated data — correcting a wrong label is legitimate operation. Forbidding it does close the
hole, but **replaces it with a different breakage — one that cannot be corrected**, leaving the
wrong label interpreted forever.

**So format joins the content gate.** Once decision 3 says a changed interpretation makes a
version, a corrected format has to make one — and that is also the correction's only place to
land: with `decideVersionCreate` looking only at the hash, a correction whose bytes are
unchanged is never captured, and the existing version goes on being read by the rule the
correction replaced. A version holding **no** format counts as a difference too (rows from
before the column existed, or inserted during a deploy window, would otherwise never be
interpreted).

The cost of a relabel is therefore **one version, one byte copy, and one layer-2 ingest**. The
first two are what decision 3 accepted; the third follows from them, since a new version holds
no snapshot and a diff or query would answer "not ingested" until it does. Whether repeated
edits inflate the history stays a UX question for open issue 2.

**How a correction reaches a re-run differs by resource type.** A metadata update re-enqueues
the pipeline for URL resources, while an upload needs the explicit "reprocess" action.
Automating the latter has to be designed alongside the PUT being a full-column replace — a
partial update that omits `format` writes null — so it belongs with open issue 2.

Tabular and non-tabular versions will now coexist on one resource, but **that mix is already in the
design**: `ducklake_snapshot_id` is already null for six reasons (non-tabular, oversize, too many
columns, empty CSV, failed interpretation, not yet ingested), and the diff service reports it as
`not-ingested`. No new branch is needed.

## Consequences

- **Durability**: a deterministic interpretation failure (OOM, malformed CSV) no longer costs layer 1.
  Only the interpretation reaches the DLQ
- **One mechanism fewer**: `lake_source_key` and its whole lifecycle
- **Memory**: no more expanding every row onto the JS heap; `MAX_PARQUET_SOURCE_SIZE` (50MB)
  can be revisited
- **DB**: the version record keeps `schema`, and the primary key and type overrides go there too.
  One `format` column is added. No new table
- **Storage**: a version that changed only its interpretation still holds a copy of the bytes,
  and carries a layer-2 ingest with it (§6)
- **Migration**: existing versions keep their `schema`; `lake_source_key` is dropped when it goes

## Open issues

1. **Parity of type inference — settled.** Measured (DuckDB 1.5.4, 29 column patterns from Japanese CSVs).
   **The middle course is not needed — the sniffer can take over.** 23 of 29 agree, and the
   guard that was ADR-029's biggest reason to exist — **leading-zero code columns (postal codes,
   municipality codes) — DuckDB also leaves as VARCHAR**. On the three date columns DuckDB is
   the better of the two, which settles ADR-029's own open issue about typing dates. Three
   conditions come with it.

   - **Require `sample_size = -1`.** The default (first 20480 rows) breaks in two ways: a value
     further down that does not fit the sniffed type lets `DESCRIBE` succeed and then fails the
     read with a `Conversion Error`, while a value that _does_ fit — a code like `0123` — is
     **silently turned into `123`**. The second is the worse one. Sniffing every row costs
     +375ms on 43.8MB / 800,000 rows (COPY 118→493ms), which is affordable
   - **Correct only the INT64-overflow case.** `99999999999999999999` is sniffed DOUBLE and
     loses its digits as `1e+20`; this is the one real regression against ADR-029's guards.
     Do not reach for `auto_type_candidates` — adding `DECIMAL(38,0)` **silently rounds** `1.5`
     to `2` and `43.064310` to `43`, whatever the candidate order. The workable fix is narrow:
     after sniffing, re-read with `types={col: 'VARCHAR'}` for columns sniffed DOUBLE whose
     source text is integer-shaped on every row
   - Accept the rest: `" 123"` → 123 (surrounding space dropped) and `1e5` → DOUBLE

   One quirk to record: **the date format is decided once per file.** A `2023/04/01` column
   appearing first makes a later `2023-04-01` column TIMESTAMP rather than DATE (reverse the
   order and both are DATE; the values survive either way). That makes the persisted schema
   (ADR-032) depend on column order — and since this ADR raises a version whenever the
   interpretation changes, it could inflate the history.

   The core claim of this ADR also held up in measurement: capped at `memory_limit=256MB`, a
   43.8MB CSV still converts to Parquet in 582ms, because
   `COPY (SELECT * FROM read_csv(...)) TO ...` streams.

2. **How an interpretation change enters**: it does not pass the content gate, so version
   numbering and claim acquisition have to be decided on the user-action side. Whether
   repeated fiddling with a key floods the history (not settling while in draft, say) is a UX
   question too. Decision 6 makes **a format divergence the first trigger** for it — "this was
   read as CSV; re-read it as TSV?" is answerable the moment the column exists
3. **Re-running Interpret — settled.** The existing layer-2 retry job
   (`LAKE_INGEST_JOB_TYPE`) re-interprets the version. Interpretation became one unit,
   `withInterpretedVersion`, shared by the pipeline and the retry; no new job type was needed
4. **What the preview Parquet is for**: an artifact of the interpretation, or generated on
   demand from layer 2 (the substance of ADR-043's "layer 3")
5. **Whether the producer of an interpretation becomes a slot**: detecting types (DuckDB's
   sniffer) and detecting structure — where the table starts, how many header rows, what a
   merged cell means — are different problems. The second is already carried by hand-written
   heuristics (`skipTitleRows`, `removeFooterRows`) and is already fragile. For spreadsheets
   built as layouts rather than tables, an AI could sit here.

   **That extension works only because this design stores the interpretation on the version.**
   An AI is non-deterministic and tied to a model version; run once and recorded, everything
   downstream reads the record rather than the model — reproducibility comes from storage, not
   determinism. A human correction stands beside it as another version, and the two can be
   compared.

   The posture is ADR-040's: **propose, do not decide**. Misreading structure shifts columns,
   which is a data integrity problem and not a UX one. As a precondition, XLSX is not in the
   tabular path at all today (`isTextFormat` rejects it), so a parser producing a cell grid
   with merge information comes first, along with a bounded sample (top-left N×M plus the merge
   map) since a whole sheet cannot be handed to a model. On a closed network (`AI_TYPE=none`)
   the heuristics stay as the fallback

## Related ADRs

- ADR-029: CSV/TSV preview column type inference (the inference moves here)
- ADR-043: Resource versioning and row-level diff (collects "layer 3", retires §6-6)
- ADR-044: Per-resource execution claim (the step order changes; kills stay the claim's business)
- ADR-045: Recording storage objects before they exist (one reference source fewer)
