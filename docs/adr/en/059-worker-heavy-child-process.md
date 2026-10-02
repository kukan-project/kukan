# ADR-059: Run the worker's heavy processing in one reused child process

## Status

**Accepted** — 2026-10-01, implemented 2026-10-02

This extends the child process that ADR-032 remaining issue 2 adopted for the web's resource queries
(option C) to the worker's heavy processing. What runs in the heavy section of ADR-058 §7
(`heavySection`) becomes a request to this child, and the layer 2 ingest that stays in process.

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

The child handles one item at a time, so when it goes down, that item is the cause. The item is
recorded as "too large to process", and the run carries on as it does after any other failure (the
task stays up and the retry does not repeat it). The next request starts the child again.

- The child's memory is measured as anonymous memory (`RssAnon`). RSS also counts the pages of
  mapped files — Node itself and the DuckDB library, about 90 MB — which the container is charged
  for once, and would come out of the child's budget
- A reused child that passes its budget or is killed by the kernel is replaced and the request run
  once more in a fresh one: what it kept from earlier requests counts against the budget too, and
  only a fresh child's going can be put on the request
- "Too large" is limited to the child passing its own budget, being killed by the kernel
  (SIGKILL), or running out of heap (SIGABRT). A stop because the container as a whole neared its
  limit is a transient failure and is not recorded on the version, since the parent's other jobs can
  be the cause. The child's budget fits inside the container's limit less the parent's share, so a
  file too large meets the child's own budget first
- Interpretation: the version records `out-of-memory` as why it has no table. Unrecorded, the hourly
  sweep would hand out the same version and take the child down every time. It is kept apart from the
  size cap's `too-large` (never stored, derived from the cap each time): this one is a fact about the
  size of the task it ran on, so a site that moves to larger tasks can find the versions to read again
- Text extraction: recorded as the Index step failing. What was indexed before stays as it was

### 3. When the child is stopped or restarted

| When                                                            | What                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mid-request, the child's anonymous memory passes its budget     | Stop the child. A reused one is replaced and the request run once more; a fresh one over it means "too large"                                                                                                                                                      |
| Mid-request, the container's memory nears its limit             | Stop the child, have the parent close the layer 2 instances no session is using, and run the request once more in a fresh child. Still short, it is a transient failure: not recorded on the version, and the job fails for the queue to run again after its delay |
| After an item, the child's anonymous memory is past a set value | Stop the child; the next request starts it (so what it kept is not carried on)                                                                                                                                                                                     |
| No request for a while after the last (about a minute)          | Stop the child and give back what it loaded (~70–100 MB)                                                                                                                                                                                                           |
| Mid-request, the run loses its claim                            | Stop the child (the parent checks the claim with the memory meanwhile)                                                                                                                                                                                             |
| A waiting child has gone (the kernel's OOM kill, say)           | The next request starts a fresh one (not a failure of that request)                                                                                                                                                                                                |
| The parent receives SIGTERM                                     | Stop the child as soon as the queue takes no more jobs, and refuse later requests. The item under way records nothing; the queue hands its job back uncounted for another task                                                                                     |
| The parent dies outright                                        | The child sees the IPC channel close and exits on its own                                                                                                                                                                                                          |

The child runs at the parent's priority (not lowered as the web's queries are): requests go one at
a time, so one slowed is every job behind it slowed.

Each start, stop, rerun and release of layer 2 instances is logged with why
(`component: heavy-process` in the worker's log). That log is what the values are tuned by.

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

## Measured (2026-10-02)

In a container with small's 1 GB and 0.25 vCPU, the development environment's 509 resources (303
CSV, 75 XLSX, 61 PDF and others) were reprocessed from their stored content. Anonymous memory is the
cgroup's (`anon` in `memory.stat`), read every 2 seconds.

**Without layer 2 ingest**

|                                 | Before (in process)  | After                |
| ------------------------------- | -------------------- | -------------------- |
| All resources                   | 872 s                | 1,116 s              |
| Anonymous memory (median / max) | 896 (mean) / 992 MiB | 375 (mean) / 749 MiB |
| Time above 900 MiB              | 61%                  | 0%                   |
| Results                         | —                    | Same as before       |

**With layer 2 ingest (each resource's latest version, 273, loaded again)**

|                                      | Before (in process)                                | After                    |
| ------------------------------------ | -------------------------------------------------- | ------------------------ |
| Worker                               | OOM-killed at 1,126 s; 231 resources never reached | Ran to the end (2,250 s) |
| Layer 2 loads                        | 146 / 273                                          | 273 / 273                |
| Anonymous memory (median / max)      | 978 / 1,006 MiB                                    | 642 / 959 MiB            |
| Time above 900 MiB                   | 70%                                                | 1%                       |
| Transient failures (container short) | —                                                  | 1 (text extraction)      |

The log of the run after, with layer 2: 35 child starts (27 of them restarts after an item, with 402–
449 MB kept in 24 and 539–625 MB in 3), 7 stops for the container being short, 6 of them rerun
successfully after closing a layer 2 instance, 0 "too large", 0 kernel OOM kills.

- Before, even without layer 2 the worker spent 60% of the time just under the limit, and with it
  the full reprocess went down partway
- After, it takes longer (+28% without layer 2). At 0.25 vCPU the CPU is used up (`throttled_usec` in
  `cpu.stat` is about 8 times the usage), so child starts (1.2–1.8 s each) and rebuilt layer 2
  instances show in the time as they are. The rest of the increase has not been broken down
- A child keeps what its largest request took and does not grow on smaller ones (377 MB after a
  50 MB CSV, unchanged by 1–5 MB CSVs after it)
- With a layer 2 instance kept open, the parent's RSS goes from a mean of 268 MiB without layer 2 to
  558–635 MiB. The instance keeps memory even with `enable_external_file_cache = false`

## Remaining issues

1. **Budget values**: the implementation went in with these (`apps/worker/src/config.ts`). The
   child's budget is the smaller of 946 MB, from the interpretation's DuckDB cap by the same rule as
   the web's queries, and the container's limit less 300 MB for the parent (724 MB on a 1 GB task,
   in anonymous memory). 64 MB kept free in the container, a restart past 400 MB (anonymous), and a
   stop after 60 seconds idle. Most restarts come at 402–449 MB, so about 450 MB would cut them to a
   tenth (about 1.5 s each) at the cost of what a waiting child holds against the layer 2 ingest. To
   be decided from the production log
2. **What a layer 2 instance keeps**: a way to have it give memory back without closing would lower
   the parent's share without the rebuild (extension loads and the ATTACH)
3. **What the rest of the time goes to**: what child starts and instance rebuilds do not account
   for (fresh children's cold JIT, the memory reads during a request, and so on)
4. **How PDFs are read**: when moving to the child, decide between pdf.js in the child and calling
   Poppler's `pdftotext`, by measuring memory, time and extraction quality on the same PDFs
   (`pdftotext` changes how line breaks and spaces come out, so existing indexes would be
   reprocessed to match)
5. **ZIP manifests**: pure computation that could move to the child, but its weight has not been a
   problem

## Related ADRs

- ADR-032: MCP data query (remaining issue 2 moved resource queries into a child process)
- ADR-043: Resource versioning and row-level diff (layer-2 ingest)
- ADR-044: Per-resource execution claim
- ADR-058: Job queue in PostgreSQL (§7's heavy section and concurrency inside one worker)
