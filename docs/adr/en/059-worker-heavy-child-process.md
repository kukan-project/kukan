# ADR-059: Run the worker's heavy processing in one reused child process

## Status

**Proposed** — 2026-10-01

This extends the child process that ADR-032 remaining issue 2 adopted for the web's resource queries
(option C) to the worker's heavy processing. The heavy section of ADR-058 §7 (`heavySection`)
becomes a request to this child.

## Context

### 1. One file takes the whole worker down

The worker does its heavy computation inside its own process:

- Text extraction (Index): PDF, DOCX, XLS, PPTX and others through officeparser, XLSX through our
  own streaming reader
- Interpretation (Interpret): CSV/TSV into Parquet with type inference, through DuckDB (a native
  addon)

When either uses up the memory on a large file, the whole worker goes down. Small and medium
workers are 1 GB containers with a 560 MB Node heap limit. What follows:

- The job is retried only after its lease and the resource's claim expire, and fails again at the
  same place in the same file. The task goes down each time until the job is `dead`
- Unrelated jobs running alongside on the same worker are taken down too, and their attempts count
  up (ADR-058 §7 set the default concurrency inside one worker to 3, so more are caught)
- While synchronous CPU work runs long, lease renewal, `/health` and `/wake` do not answer

### 2. What could be made lighter has been

- PDF: read a range of pages at a time, and stop pdf.js building glyph paths it only needs for
  drawing. A 1.7 MB PDF heavy with charts went from 3.4 GB to 366 MB for the whole document
- XLSX: stream the sheet XML (21 MB: 1.4 GB → 27 MB)
- DuckDB: interpretation and layer-2 ingest are bounded (512 MB), and the heavy section runs one at
  a time (ADR-058 §7)

Some remains:

- DOCX stays on officeparser. Its heap is about 60× the unpacked `document.xml`; across 39 real
  municipal documents the most was 293 MB. Producing the same text from a rewrite would mean
  redoing most of some 1,200 lines (list numbering, footnotes, text boxes, merged cells), so it was
  set aside
- XLS, PPTX and the other formats left on officeparser have not been measured
- DuckDB uses native memory, so going past its limit is a container OOM, not a Node heap limit

Making things lighter lowers the odds of going down; it does not change what goes down with it.

### 3. A child process separates the unit of failure

- Fargate's cgroup is v1 (platform 1.4.0, confirmed on demo) and has no `memory.oom.group`. The
  OOM killer does not take the container's processes down together; it takes the one with the
  highest `oom_score`
- Fargate sets the worker's own (PID 1) `oom_score_adj` to −998. A child that raises its own to
  +1000 is reliably the one the OOM killer picks (raising needs no privilege)
- When the Node heap limit is what is hit, a child's heap is what runs out, and the parent stays
- The web's resource queries already run this way (ADR-032 remaining issue 2, `query-process.ts`)

### 4. Starting a child per item is slow

In a container with the small scale's 0.25 vCPU, from the parent forking a child to its ready
message:

| What the child loads               | 0.25 vCPU | Local (no limit) |
| ---------------------------------- | --------- | ---------------- |
| Nothing                            | ~0.1 s    | ~0.02 s          |
| officeparser                       | ~0.5 s    | ~0.07 s          |
| DuckDB (up to opening an instance) | ~0.6 s    | ~0.1 s           |

A full reprocess of 509 resources would add CSV 320 × 0.6 s + PDF/XLSX/XLS/DOCX 237 × 0.5 s
≈ 310 s of CPU time per task. Starting a child is CPU-bound, so on small, more concurrency does not
shrink it. A web query can start one each time at a cost lost in a person's single action; the
worker has many items.

## Options considered

- **A) As now (in process, one heavy section at a time)**: no cost. The odds of going down are
  lower, but what goes down with it is the same
- **B) Start a child per item (as the web's queries do)**: simple, and every item gives all its
  memory back. The start cost (§4) is paid per item
- **C) Use a child only for dangerously large files**: costs only a few starts. But the threshold
  has to be set per format, and a failure under it is the same as A. DOCX can be estimated from the
  unpacked `document.xml`, but DuckDB and the other formats have no such measure
- **D) Keep a child running and reuse it (adopted)**: the start cost is paid once. All heavy
  processing can go through the child
- **E) Group several resources into one job**: spreads the start cost, but does not fit the
  per-resource claim and retry (ADR-044)
- **F) A separate container (sidecar)**: a cgroup enforces the limit exactly, but it adds to the
  task definition, the memory split and the communication. Splitting small's 1 GB in two leaves
  both cramped

## Decision

The worker keeps one child process for heavy processing and reuses it while it runs (D).

### 1. What the child does

- Text extraction (officeparser, PDF, the XLSX streaming reader) and CSV/TSV interpretation
  (DuckDB)
- Pure computation: it takes local files and returns files and JSON. The parent holds the DB,
  storage, OpenSearch and the claim
- One item at a time. The same limit as the heavy section today (one at a time); the request to the
  child becomes the section's body
- Layer-2 ingest stays in process. It needs the DuckLake catalog's credentials, which would mean
  handing the child a secret. That instance is bounded in memory, threads and catalog connections

### 2. A child that goes down fails that one item

The child handles one item at a time, so when it goes down, that item is the cause. The step is
recorded as "too large to interpret" and the run ends (the task stays up and the retry does not
repeat it). The next request starts the child again.

### 3. When the child is stopped or restarted

| When                                                                 | What                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Mid-request, the child's RSS or the container's memory passes budget | Stop the child and fail that item (the ADR-032 watch)                |
| After an item, the child's RSS is past a set value                   | Stop the child; the next request starts it (so its heap cannot grow) |
| No request for a while after the last (about a minute)               | Stop the child and give back what it loaded (~70–100 MB)             |
| Mid-request, the run loses its claim                                 | Stop the child (the parent checks the claim with the RSS meanwhile)  |
| The parent receives SIGTERM                                          | Stop the child too                                                   |
| The parent dies outright                                             | The child sees the IPC channel close and exits on its own            |

### 4. The child's environment

- Environment variables cross on an allowlist, and no secret does (as in ADR-032). The worker
  parses untrusted input files, so the separation is a security gain too
- The child first raises its own `oom_score_adj` to +1000
- The parent makes the temporary directory, passes it, and removes it (a child can be stopped
  midway, so it cannot clean up after itself)
- The child's code is a second tsup entry of the worker, next to it in `dist`. No setting like the
  web's `QUERY_CHILD_ENTRY` is needed

### 5. Shared mechanism

Starting the child, watching its RSS, the allowlist and cleaning up the temporary directory are
factored out so the web's queries (a child per query) and the worker (a reused child) both use them.

## Consequences

- One file takes down only the child; unrelated jobs running alongside on the worker are not
  caught
- While the child is up, it holds its memory (~70–100 MB); it gives it back once idle
- More passes between parent and child (text and Parquet are already written to files, so what is
  added is the JSON exchange)
- Extraction and interpretation results do not change (the same code runs in the child)

## Remaining issues

1. **Budget values**: the child's RSS budget, the RSS past which it restarts after an item, and how
   long it stays idle before stopping. Set by measuring the parent's (~250 MB) and the child's share
   of small's 1 GB
2. **How PDFs are read**: when moving to the child, decide between pdf.js in the child and calling
   Poppler's `pdftotext`, by measuring memory, time and extraction quality on the same PDFs
   (`pdftotext` changes how line breaks and spaces come out, so existing indexes would be
   reprocessed to match)
3. **ZIP manifests**: pure computation that could move to the child, but its weight has not been a
   problem

## Related ADRs

- ADR-032: MCP data query (remaining issue 2 moved resource queries into a child process)
- ADR-043: Resource versioning and row-level diff (layer-2 ingest)
- ADR-044: Per-resource execution claim
- ADR-058: Job queue in PostgreSQL (§7's heavy section and concurrency inside one worker)
