# ADR-046: Separating the canonical copy from its interpretation

## Status

**Proposed**

Make the canonical copy (layer 1) durable **before** anything interprets it. Fold type
inference, Parquet generation and the DuckLake ingest into one re-runnable stage, on DuckDB.
Define a version as "these bytes, read under this interpretation" — so changing the
interpretation makes a new version.

Collects ADR-043's open issue "unifying the preview Parquet (layer 3)".

## Context

### 1. The write we least want to lose sits behind the step most likely to die

The order today is Fetch → Extract → Version → Lake → Index. Version — the canonical copy,
layer 1 — comes after Extract for one reason: **so the column schema Extract produces can be
burned onto the version row**.

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
- **Against**: dying between the insert and the update leaves a version row whose schema is
  **null for good** — the content has not changed, so no later run captures it, and nothing
  attaches a schema to an existing row. That means another repair pass. The preview dependency
  and the burn-in problem both remain

### C) One interpretation stage, on DuckDB

Fetch → Version → Interpret → Index, where Interpret does type inference, Parquet generation
and the layer 2 ingest in a single DuckDB session.

- **For**: the OOM path disappears (`COPY (SELECT * FROM read_csv(...)) TO ... (FORMAT
parquet)` streams). Layer 2 reads the version file, so the preview dependency goes. The stage
  is re-runnable, so changing a primary key re-runs **only that**
- **Against**: type inference moves from ADR-029's own implementation to DuckDB's sniffer.
  DuckDB's `read_csv` **cannot read Shift_JIS** (utf-8 / utf-16 / latin-1 only), so encoding
  detection and the UTF-8 conversion stay in front of it

## Decision

**C**, together with a definition of what a version is.

```
Fetch ─→ Version ─────────────→ Interpret ──────────────→ Index
        layer 1, all formats    one DuckDB session:
        bytes only              infer → Parquet → layer 2
                                ↑ re-run this alone on a key/type change
```

### 1. Layer 1 carries no interpretation

Version runs right after Fetch, as the lightest work there is — a server-side copy and an
insert. It is the same for every format and does not care whether the content is tabular.

Kills are unaffected. The version insert is conditioned on the claim (ADR-044 §4), so a
stopped run leaves no version whatever the order. **The claim decides that, not the ordering.**

### 2. Interpretation is one re-runnable stage

Inference, Parquet and the ingest read the same input — the version file — in the same DuckDB
session. All three share one interpretation by construction, and since the input is immutable,
a failure can be retried any number of times.

**The unit of re-running becomes the interpretation.** Retrying a failed ingest and changing a
primary key both run this stage alone, without Fetch. The first adds no version, the second
does (below) — what differs is not the input but whether the interpretation changed.

### 3. Changing the interpretation makes a new version

A version is not "those bytes" but **"those bytes, read under this interpretation"**.
Assigning a different primary key or type creates a version; it never rewrites an existing row.

That dissolves the mutable-judgement problem — **nothing mutates**. The history of
interpretation changes lands in the version history, so who changed what and when is visible
there as well as in the audit log, and no new home is needed outside the version row.

The schema still is not settled at capture, so the write to the version row happens after
Interpret. B's drawback is not one here: **unassigned is a normal state**, with a path in the
UI to fill it.

**The bytes are copied.** A version that differs only in interpretation still gets a version
file of its own. Sharing one object between two versions would avoid the copy, but **one
version = one object is an invariant the purge depends on**. Shared, purging v2 either
destroys v3's bytes or fails to destroy anything — a legal deletion that does not delete. A
50MB copy is cheap against that.

Two consequences. **The content gate does not see an interpretation change**:
`decideVersionCapture` compares hashes against the latest active version, so identical bytes
are not captured. Interpretation changes arrive through a user action, not the pipeline. And
**several versions sharing a hash becomes normal**; the places that look a version up by hash
(a revert's starting point, the version awaiting ingest) take the newest match and stay
correct.

### 4. `lake_source_key` is retired

Once layer 2 reads the version file, everything in context 2 goes. A version awaiting ingest
is simply "active, with no snapshot id", and that alone is the condition the hourly sweep
needs.

### 5. Encoding stays in front

`Encoding.detect()` and the UTF-8 conversion cannot be handed to DuckDB. The converted object,
produced by streaming, is what Interpret reads. Handling Japanese CSVs is not negotiable.

## Consequences

- **Durability**: a deterministic Extract failure (OOM, malformed CSV) no longer costs layer 1.
  Only the interpretation reaches the DLQ
- **One mechanism fewer**: `lake_source_key` and its whole lifecycle
- **Memory**: no more expanding every row onto the JS heap; `MAX_PARQUET_SOURCE_SIZE` (50MB)
  can be revisited
- **DB**: the version row keeps `schema`, and the primary key and type overrides go there too.
  No new table
- **Storage**: a version that changed only its interpretation still holds a copy of the bytes
- **Migration**: existing versions keep their `schema`; `lake_source_key` is dropped when it goes

## Open issues

1. **Parity of type inference**: how DuckDB's sniffer differs from ADR-029's own inference on
   Japanese CSVs is unmeasured. If the gap is wide, a middle course — keep the inference,
   move only the Parquet generation — is available
2. **How an interpretation change enters**: it does not pass the content gate, so version
   numbering and claim acquisition have to be decided on the user-action side. Whether
   repeated fiddling with a key floods the history (not settling while in draft, say) is a UX
   question too
3. **Re-running Interpret**: a new queue job type, or a mode on the existing pipeline job
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
