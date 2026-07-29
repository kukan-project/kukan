# ADR-044: Per-Resource Execution Claim

## Status

**Proposed**

Limit a resource to one running operation at a time, expressed as a claim on its
`resource_pipeline` row. Pipeline runs and purges share the same claim.

## Context

Four concurrency defects surfaced in quick succession while implementing ADR-043.

| Defect                 | What happens                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Version inversion      | A run overtaken after publishing files its older bytes as a newer version, leaving live content behind its own latest version |
| Stranded upload key    | Concurrent uploads leave the losing key referenced by nothing and reclaimed by no one                                         |
| Metadata applied early | An abandoned upload leaves the old content described by the new file's name and type                                          |
| Out-of-order ingest    | A late ingest rewinds DuckLake's current contents                                                                             |

All four come down to **two operations running against the same resource at once**.
Each was closed individually with a compare-and-swap, a generation fence or an ordering
guard, but that approach carries three properties:

- **Every write site needs its own condition.** One omission is a defect — the version
  inversion was exactly that: the fence existed at the Fetch boundary and nowhere after it.
- **Writes outside PostgreSQL cannot be conditioned.** The search index (OpenSearch) and
  storage writes do not fit in a SQL predicate; the best available is check-then-write.
- **The design assumes a window remains**, so "what should an overtaken run do?" has to be
  answered in every step.

### Current state this builds on

- `resource_pipeline` has a unique index on `resource_id`, so there is **already one row
  per resource**, with `status` and `updated`
- Nothing enforces exclusivity between runs. SQS delivers at-least-once, and rapid
  replacements overlap on their own
- Purge is a separate job type (`purge-version`) with no exclusion against the pipeline
- There is no way to detect a hung run, and no way to stop one

## Options Considered

- **A) Keep adding compare-and-swaps (the current trajectory)**: condition each write on
  "am I still the newest run". It matches the existing idiom but keeps all three properties
  above. An omission is fatal, and writes outside Postgres cannot be made exact at all.
- **B) A per-resource execution claim (adopted)**: take a claim when a run starts, so
  concurrency never arises. Contention moves from "detect and repair" to "**does not
  happen**". The cost is that a stuck claim stops that resource being processed.
- **C) Move the queue to a DB backend and serialize on a singleton key**: withdrawn in
  ADR-022 (incompatible with Aurora Serverless at 0 ACU, multiplied per site). Being
  lease-based, it also leaves the window where a stalled run outlives its lease — so it
  needs the same backstop as B.

## Decision

**The `resource_pipeline` row is the resource's execution claim.**

### 1. What the claim covers

The claim is the `resource_pipeline` row itself; no new table (the one-row-per-resource
constraint already exists). The row records an **owner (a run id)** — see §3 for why.

It covers **both pipeline runs and purges**. Both rewrite the resource's content, so they
must exclude each other. "No new version until the purge finishes" follows from that.

**Jobs that span resources take a claim on each one they touch** — the backfill, reindex,
and package and organization purges. That looks heavy-handed until you check what happens
without it; at least two of the outcomes do real damage.

**Purge against a pipeline run — a hole in legal deletion.** Extract writes the preview to
storage **before** returning, and the DB write happens afterwards; version capture likewise
copies the object before inserting its row. If a package purge lands in that window, the
pipeline writes the preview and the version file **after** the purge has finished cleaning
up. The DB writes fail harmlessly with the rows gone — but **the objects stay**. The
purge's own cleanup has already passed, nothing parked them in `orphaned_object`, and the
DuckLake orphan sweep only looks under `lake/`. **There is no path that collects them.**
Content is written back moments after a deletion claimed to have erased it, and stays.

**Backfill against a pipeline run — what §5 depends on.** The backfill takes
`VERSION_CAPTURE_LOCK` today, so concurrent runs cannot collide on a version number. §5
proposes removing that lock, so if the backfill takes no claim, **removing it leaves
nothing**: two runs pick the same number, one copy overwrites the other's file, and the
unique index keeps only one of the rows — exactly what the lock was there to prevent.

### 2. Taking the claim

A run takes the claim first. If a live claim is already held it **does not start**. The
job completes rather than failing, and leaves the queue: another run already owns the
content, so retrying means nothing.

The claim is taken in one statement, never read-then-write. **A set of resources is taken
in one statement too.** Nothing waits, so there is no acquisition order to agree on and
nothing to deadlock against (settling open issue 2). If even one of them is held, the ones
taken are given back and the job **abandons the whole set** — doing half of a purge creates
exactly the state the claim exists to prevent. The caller retries.

**Taking the claim does not touch the row's own state.** `status` and the clearing of steps
are the run's record of itself, not part of the claim: a purge holds the claim without ever
being "processing", and that distinction has to survive. The write in which a run resets its
own record is safe precisely because it happens while holding the claim.

A resource with no pipeline row cannot be taken — and cannot be run against either, so
there is nothing to exclude and a purge simply proceeds.

### 3. Releasing the claim — three paths

**Normal completion**: a run that finishes releases it.

**Automatic takeover**: a claim whose steps have not progressed for a set period can be
taken by another run. This is what makes a dead worker (OOM, task replacement, deploy)
self-healing; without it every redeploy would leave stuck claims for someone to clear by
hand.

Progress is read from the running step's **`resource_pipeline_step.started_at`**, not from
`resource_pipeline.updated`: only `startPipeline`, `updateStatus` and
`updateExtractResult` advance that one, so everything from the end of Extract to the final
update looks like no progress at all. A value that moves at each step boundary means the
threshold only has to exceed the **longest single step**.

**The threshold is 15 minutes.** Fetch is capped at 30 seconds by `AbortSignal.timeout`,
Extract's input is capped at 50MB of CSV, Version is a server-side S3 copy, and Index is
chunking and indexing — all expected in the order of minutes. Several times that leaves no
risk of taking a run that is merely slow. It is **derived from the input caps, not measured
in production**, so it goes in as a fixed value and moves to a runtime setting (ADR-036) if
measurement calls for it.

**Why the owner is recorded.** When a takeover happens, the displaced run has to be able to
find out. Without an owner, (1) that run's final `updateStatus` **releases someone else's
claim**, (2) its writes advance `updated` and **fake liveness**, and (3) the run itself
**cannot tell it was displaced and keeps going**. (3) is what §5 rests on: "the claim means
the generation fence can go" only holds if a displaced run has some way to know. With an
owner, its writes can carry `WHERE owner = me`.

**Manual kill**: an operator can stop a run without waiting for the threshold — an
external URL that is known not to be answering has no reason to wait it out. A kill
releases the claim and marks that run cancelled.

Takeover and kill are not alternatives. **Both a state worth judging and a way to act on
that judgement are needed.**

### 4. Stopping a run

Surface that a resource is being processed, and for how long. There are two reasons to stop
a run, and they need different reach.

**The run is stuck** (an external URL that never answers, a hang) — what has to stop is the
processing, not the content.

**The content is wrong** (the wrong file was uploaded) — what has to stop is the processing
**and** the exposure of that content. The second is the more urgent of the two: an overtaken
run goes on **feeding the content the user is retracting into the search index**. That is
not "a derivative is briefly stale" (what §5 accepts) — it is wrong content becoming
findable from anywhere in the catalog.

So the actions separate by how much they destroy, and each is **chosen explicitly**.

| Action             | Stops                              | Content                                            |
| ------------------ | ---------------------------------- | -------------------------------------------------- |
| Stop processing    | preview, index and version capture | left alone                                         |
| Stop and roll back | same                               | restored to the previous version (emptied if none) |
| Purge the version  | same                               | the version file goes too                          |

They are not welded together because someone stopping a stuck run does not want the content
reverted — and if that content was the resource's first version, there is nothing to revert
to and **the resource is emptied**.

The rollback needs no new mechanism. It is what a version purge already does when the purged
version was live: restore the previous one, drop the preview and the search content, and
enqueue reprocessing.

A purge also deletes the layer-1 version file, so **that version stops being downloadable**.
The screen offering it must say so and ask for confirmation. Purges reuse the existing
mechanism (sysadmin only, reason required, audit logged).

**Starting a replacement kills the run.** `prepareForUpload` does not take the claim (§6), so
whether an upload overtakes a run depends on where that run happens to be — chance. Stopping
the run when the intent to replace is declared removes that. The content is untouched;
whether to roll it back is the user's choice from the three above. If the replacement is then
abandoned, the resource is left without derivatives — a safe direction to fail for a file
someone was trying to retract.

**A kill needs teeth.** Today only the release is conditioned on the claim's owner; step
records, preview updates and index writes do not check it. Releasing the claim therefore does
not stop the run, so **conditioning the run's derivative writes on `WHERE claim_owner = me`**
is a precondition for killing at all. A run that finds the condition gone leaves quietly, as
cancelled rather than as an error.

This looks like partly restoring the step-boundary fence §5 removed, but the question is a
different one. What went was "am I still the latest?" — a defence against a race the claim
now prevents. What arrives is "do I still hold this?" — the path by which a user's explicit
action reaches a running job.

**Show that the resource is half-done.** A killed run — or an abandoned replacement — leaves
a resource **holding bytes with no version**. It downloads, but there is no preview, no
search content and no `resource_version` row, which means **layer 1 never captured that
content and it stops being recoverable the moment something replaces it**. Killed right after
a replacement, `hash` is still NULL as well (`promoteUpload` writes NULL and the pipeline
fills it in from what it measures).

Nothing surfaces this today. The pipeline row is neither `complete` nor `error`, and
`countUnversioned()` requires `hash IS NOT NULL`, so it does not count the NULL ones. **It
goes half-done quietly.** So:

- add a terminal `cancelled` status to the pipeline, distinct from `error` — it was not a
  failure
- show on the resource that it holds content no version has captured, with a way to
  reprocess it

### 5. What the claim lets us remove

Half the point of a claim is that it lets individually-placed defences go. Keep the
removals and the retentions explicit.

**Removable: the step-boundary generation fence**

It asks the database "am I still the newest run" before Extract, Lake and Index. What it
protects — preview, search index, pipeline row — is **derived state the next run
overwrites**, so being wrong means being briefly stale. With a claim, overtaking barely
happens, and a round trip per step is not worth it. The context method that answers it
goes with it.

**Removable: the version-capture advisory lock (`VERSION_CAPTURE_LOCK`)**

It serializes version numbering and insertion per resource — **the same scope the claim
covers**. The backfill takes the same lock, so once the backfill takes a claim instead,
the lock can be folded away entirely. One locking mechanism fewer.

**Absorbed: serializing the Lake retry**

Once purge, pipeline and retry exclude each other under the claim, no separate
serialization is needed.

### 6. What stays

**The pointer comparison in version capture**

A run whose claim was taken can still be alive, and will arrive to capture a version
without holding one. That is the **only lasting damage** — older bytes filed as a newer
version in an append-only table — so it stays as the last line. It compares a row already
being read under the lock, so it costs nothing.

**The DuckLake ordering guard**

A claim prevents overlap; it does not order things **across time**. The retry runs later
as its own job, so ingesting an older version after a newer one is still reachable. A
different property, and not removable.

**The live-pointer compare-and-swap**

**Uploads do not take the claim.** Everything from `prepareForUpload` to `promoteUpload` runs
on an API request, outside it. So this condition still fires under a claim — when **a user
replaces the file while a run is in flight**. That is what Fetch's `superseded` now means.

Without the condition, the overtaken run's publish would pull the resource back to its own,
older bytes. There is a real counterparty, so keeping it is not a secondary call. The
statement also moves pointer, hash and size **together** and parks the key it replaces, so
dropping the condition alone would not simplify it either.

**Pending-upload atomicity**

Two HTTP requests racing, touching neither the pipeline nor a purge. Outside the claim's
scope, and remains a problem at its own layer.

## Consequences

- **DB**: `resource_pipeline` records the claim's owner (a run id). Liveness is read from
  the running step's `started_at`, so no expiry column is needed
- **Worker**: the pipeline, purge, Lake-retry and backfill handlers take the claim and do
  nothing without it. The step-boundary fence and the version-capture lock are removed (§5)
- **API**: package and draft purges run over HTTP, so they take the claim too (409 for a
  retry when they cannot). Plus routes to report a run's state and to kill it
- **Frontend**: processing state and elapsed time, the kill action, and the purge path
  with its warning
- **Operations**: a hang does not resolve itself; it waits for a decision. Layer 1
  (versions, downloads, replacement) is unaffected, so waiting is the safe direction

**Net effect**: one mechanism is added, and two go — the generation fence (a context
method and three call sites) and the version-capture lock. Defence moves from "a condition
at every write site" to "one check at the entry point", which is a smaller surface to
leave a hole in.

## Open Issues

1. **Measuring the threshold**: 15 minutes comes from the input caps (100MB fetched, 50MB
   of CSV), not from the longest step observed in production. To be tightened once measured
2. ~~**Granularity for bulk jobs**~~: settled (§2). One statement, so no acquisition order
   and no deadlock; one resource held abandons the whole set for a retry
3. **Serializing the Lake retry**: absorbed into the claim (the retry job takes one too).
   What remains is what to do once a mid-history version's preview has been swept: today
   it gives up, logging a warning. Whether to go further and purge is unsettled
4. ~~**Ordering of the removals**~~: settled. §5 was carried out once every path took the
   claim — the `isSuperseded` fence with its three call sites, and `VERSION_CAPTURE_LOCK`

## Related ADRs

- ADR-002: SQS over BullMQ (at-least-once delivery is one source of duplicate runs)
- ADR-022: DB polling instead of SQS (withdrawn; also re-examined for correctness)
- ADR-028: Async organization purge with a durable claim (the precedent for this pattern)
- ADR-043: Resource versioning and row-level diff (where these races came from)
