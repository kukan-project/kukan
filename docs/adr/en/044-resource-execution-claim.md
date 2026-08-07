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
constraint already exists). The row records an **owner (a run id)** — see §3 for why — and
**what is holding it**: a pipeline run, or a job that merely needs runs kept away (see §4).

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
nothing to deadlock against (settling open issue 2). If even one of them is held, the job
**abandons the whole set** — doing half of a purge creates exactly the state the claim
exists to prevent. The caller retries.

**Taking them and giving them up belong to one transaction.** Released by hand, a process
that dies between the two leaves **an owner holding resources it is not working on**: nothing
runs and nothing can, until the claims go stale. A rollback leaves no partial acquisition to
clean up.

**Taking the claim does not touch the row's own state.** `status` and the clearing of steps
are the run's record of itself, not part of the claim: a purge holds the claim without ever
being "processing", and that distinction has to survive. The write in which a run resets its
own record is safe precisely because it happens while holding the claim.

**A resource with no pipeline row gets one from the acquisition, then is taken.** The row
_is_ the claim, so without minting it there is nothing to take and the caller proceeds with
no exclusion at all — while a `/run-pipeline` arriving a moment later mints the row and
starts under it (open issue 6, settled). Minting is `INSERT ... SELECT ... ON CONFLICT DO
NOTHING`, one statement whatever the count. Selecting from `resource` leaves out an id whose
resource is already gone rather than failing the whole set on the foreign key. An empty
result therefore means one thing only: **the resource itself is gone**.

**This one statement does wait, so `ORDER BY id` pins the insertion order.** `ON CONFLICT DO
NOTHING` blocks on a conflicting row another transaction has inserted and not yet committed,
until it learns whether that row is going to exist (measured). Two acquisitions over
overlapping sets inserting in opposite orders **deadlock** there — the one thing this section
says acquisition cannot do. Left unwritten, the order is whatever the plan plays back (heap
order, as measured), which agrees between sessions only by accident; the sort makes it agree
by construction.

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

A purge destroys the layer-1 version file too, so **downloads of that past version are lost**.
The screen offering it says so and asks for confirmation. The purge reuses what already
exists: sysadmin only, a required reason, an audit log entry.

> What follows are the decisions and why they were made. **How they mesh in the
> implementation** — which statement carries which predicate, and where it lives — is in
> `docs/pipeline.md` §2, §3 and §6.

#### A revert deletes no versions — `superseded`

Leaving the version stepped off active leaves it **the highest active version**, which breaks
the invariant "the live content is the highest active version". Both of the places that read
that invariant break with it: the capture gate captures a spurious version (and a second
revert steps off that one and lands on **exactly what the first revert retracted**), and the
purge moves no pointer — destroying the version file while the live object keeps serving a
copy of those same bytes, **a legal deletion that does not delete**.

So there is a fourth state. `superseded` destroys nothing; destroying is the purge's job. What
it takes away is only candidacy for being live. **The transition diagram, and what each state
is still entitled to, are in ADR-043 §1.1.**

**A revert lands not on "the newest version" but on "the newest version below the one the
content is standing on".** A stopped run may have captured the very file being retracted, and
going back to that is going nowhere. "The newest version that is not the content being
retracted" is not enough either: no version record is deleted, so after one revert the version it
stepped off is still active and still newest, and the next revert would **put back what the
last one retracted**. The landing point follows from where the resource is standing. And where
it is standing is found by hash, because the live pointer names an object and not a version —
**the newest version holding those bytes**. A plain hash match will not do: several versions
may legitimately hold one hash (ADR-046 decision 3), so that answers yes for any of them. The
purge's liveness test asks the same question, differing only in the states it counts.

The format the version was captured under goes back with its content (ADR-046 §6). A version
is those bytes read under that format, so restoring only the bytes restores half of it —
leaving the label behind has the same bytes filed again under a new number.

#### The contract — `restoreTo` and `ifLiveRevision`

**A revert is absolute, and guarded by the generation the caller saw.** Two separate problems,
so two separate fields.

`restoreTo` says **where the content goes**, not how many rungs to step. Run twice, a relative
operation is not the operation run once — the second pass steps off what the first restored —
and a response lost after the pointer moved leaves a caller who cannot tell which of the two
they are about to do. Naming the destination makes a resend land in the same place, with
nothing remembered between attempts and no operation ledger to keep.

`ifLiveRevision` is what stops a request **overtaken by a newer upload** from retracting content
its caller never saw. Idempotency does not give that: "have I already done this" and "is this
still the thing I was shown" are different questions, and answering only the first turns a stale
request into a silent overwrite.

| State                  | Answer                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| already at `restoreTo` | the content does not move, and **nothing is cleaned up** (below) |
| the generation matches | do the work                                                      |
| otherwise              | 409                                                              |

A version number cannot serve as the generation: **content can be live with no version holding
it** — an upload no run has captured — so `resource.content_revision` is re-minted by every
writer of the live pointer. The storage key would identify it too, but naming internal objects
in a response is what `publicResourceColumns` exists to prevent, so the generation is its own
opaque value.

**The destination is validated.** Left unchecked, naming a superseded or missing version
supersedes everything above it and then restores whichever is newest active — a different
version, or none — and reports success. Superseded is refused rather than resolved: stepping
back onto content an earlier revert set aside is redo, which this ladder does not have. **A
revert walks the history backwards, so going forward is always a new version** — otherwise a
second revert would hand back what the first one retracted (above).

**The content is not lost, though.** A superseded version keeps its file and stays
downloadable (only `purged` is refused). Someone who reverted by mistake can download that
version and upload it again — what comes back is **a new version**, not the one that was set
aside.

#### When the claim is taken

**The decision comes before the claim, or inside the statement that takes it.** Taking the claim
stops whatever is running (§3), so any judgement that ends in "do not proceed" placed _after_ it
means **a request that is refused costs a run its work on the way out**. The generation check is
a condition on the stop-and-take statement, and **the read of the content itself carries it
too** — an upload can publish in the moment after the takeover matched, since uploads take no
claim (§6), and without the condition that upload becomes what the revert retracts. The
destination check and "already at the destination" are read before the claim is touched at all.

**A row to claim is created first.** The row _is_ the claim (§1), so a resource without one
cannot be held and the work proceeds **with no exclusion at all** — a `/run-pipeline` arriving
a moment later runs alongside it. The row is created, then claimed; a run that got there first
takes it and this steps aside. The revert path was at one point the only one doing this;
**it moved into acquisition (§2) so every path has the guarantee** (open issue 6, settled).

That row keeps the column's own default, `pending`, because that is what it is: a row with
nothing queued and nothing run. `cancelled` would read as a run having been stopped, and a
screen answers that by offering a reprocess. Nothing else ever writes `pending`, so **clients
treat it as terminal** — left non-terminal, they poll for a run that is never coming.

The statement that detaches the pointers carries the generation as well, since an upload takes
no claim (§6) and so changes the content from outside the claim entirely. Landing on no rows
parks nothing and deletes nothing.

#### Cleanup, and how it is repaired

**Nothing is cleaned up when the content is already at the destination — unless the resource is
empty.** The derivatives there normally belong to the _restored_ content, and a resend arriving
after the rebuild would delete the very preview and index it should be keeping. An empty
resource has no such content to protect: whatever is left describes the withdrawn file, so
deleting it is right whenever it is asked. **That is the only repair an emptying revert has** — reprocessing has nothing to rebuild from.

That delete is made **under the claim, taken as a `job` rather than as a takeover**. Emptiness
is what justifies it, so it has to still hold when the delete happens. And a run against an
empty resource is a fetch that has not published yet, leaving the resource empty and its
generation untouched — invisible to the generation condition — so taking over would cancel
**the very run that was about to fill it**, with nothing here to re-queue it. Claimed as a job,
a held resource is left alone: whatever holds it writes its own derivatives over these.

**What a revert queues is a rebuild, not an ordinary run.** Fetch re-reads an external URL, so
for a resource reverted _because_ that URL served the wrong thing, the job queued to finish the
retraction publishes it straight back — the revert undoing itself. A rebuild regenerates the
derivatives from the object the resource already holds and fetches nothing.

**The flag rides the claim-contention retry too.** Dropped there, the next attempt is an ordinary
run again — the flag would hold for only as long as one delivery.

**Cleanup past the pointer move reports rather than throws.** The retraction has happened, so
returning a failure misstates the outcome. The derivative delete and the search delete are
attempted independently — a storage failure that took the search delete with it would leave
retracted text reachable from the whole catalogue — and the result comes back as `cleanedUp`.
The repair is the standing control below — in neither case another revert. Derivatives have
parking, so a failed delete is collected by the hourly sweep (ADR-045 §4); **the search index
has no equivalent**, which is why that standing control has to exist.

**Rebuilding is its own action.** Queueing one is not doing it, and that run can fail later —
so being at the destination does not mean the rebuild happened, and a resend queues it again.
If the only safe repair then is "resend that revert", **whoever did not keep the request cannot
repair it** — the screen lives in a dialog, and closing it, reloading, or a different admin
opening it is enough to lose the pair.

So "regenerate the derivatives from the stored object" is a **standing control on the screen**.
It carries no state and is safe to press at any time, so nothing has to be remembered for the
repair to be available.

**It has two shapes.** With content, it queues a rebuild; **with none, it clears the leftovers
under the claim**. Queueing a run against an emptied resource fails outright — Fetch has no
object to measure — so a single-shape control would be offering a repair guaranteed to do
nothing. Which case applies is read on the server: a control that has to be _told_ is a control
whose caller must have kept the answer, and not having to keep one is the whole point.

**The caller holds the pair it was shown.** `restoreTo` and `ifLiveRevision` are read when the
confirmation opens, not when it is confirmed: read again at confirm time, polling can move them
onto content the user was never shown. They are held through an unknown outcome too — a freshly
read pair is the _next_ rung down, not this operation again.

**Known limitation: a version superseded before it reached layer 2 can never reach it**
(open issue 7).

#### Getting the kill through to the run

**Starting a replacement kills the run.** `prepareForUpload` does not take the claim (§6), so
whether an upload overtakes a run depends on where that run happens to be — chance. Stopping
the run when the intent to replace is declared removes that. The content is untouched;
whether to roll it back is the user's choice from the three above.

**A kill needs teeth.** Releasing the claim does not on its own stop the run, so
**conditioning the run's writes on `WHERE claim_owner = me`** is a precondition for killing at
all. A run that finds the condition gone leaves quietly, as cancelled rather than as an error.

This looks like partly restoring the step-boundary fence §5 removed, but the question is a
different one. What went was "am I still the latest?" — a defence against a race the claim
now prevents. What arrives is "do I still hold this?" — the path by which a user's explicit
action reaches a running job.

**Reading the claim is not enough; the condition has to be ordered against the cancel.** Read
with a plain `EXISTS`, the row comes from the statement's snapshot. If the statement then
waits — because the row it is updating is held by someone else — it re-checks against a view
of the claim taken **before** the cancel and writes anyway: `cancelResourceRun` returns having
stopped the run, and the stopped run's write lands afterwards. Measured, not reasoned. So the
claim row is read `FOR SHARE`. **A kill waits out one statement of the run it is killing** —
not a side effect, but the price of "stopped" meaning nothing more lands.

**A kill reaches as far as the next step boundary.** Every step opens by checking the claim,
so what survives is the body of the one step that was running, and almost everything it writes
is the run's own record, which the condition erases. Two writes stay with **the resource**
rather than with the run — the version record and the live pointer — and those carry the claim
individually. Without a way to interrupt a read in progress, the step boundary is as
fine-grained as a kill can be, and conditioning those two is what that costs.

**The writes that leave the database have no row to condition on.** A chunk sent to the search
index, a version loaded into the lake catalog: there is nowhere to hang
`WHERE claim_owner = me`, so these ask whether the claim still holds before each write. But
**asking is not fencing** — the claim can go between the answer and the write. What it buys is
the size of that window: asked per chunk, a kill stops at the next one. Closing it entirely
needs each document in the index to carry the run that wrote it, which is more than the
exposure warrants. (That check takes no `FOR SHARE`: what follows its answer goes somewhere no
lock reaches, so the lock would only hold up a kill it cannot help.)

**What this does not guarantee, stated plainly.** It is not a guarantee that retracted content
stays out of search. The window is open in two directions.

- A late chunk putting retracted content back — normally overwritten, because a revert queues
  the restored content for reprocessing. Not overwritten in **the case where there was nothing
  to go back to and the resource was emptied**: there is no reprocessing to queue
- A late delete landing on the restored content's index — this **does not repair itself**, as
  the delete arrives after the re-index and nothing queues another run. The resource drops out
  of search until something processes it again (layer 1 is untouched; one reprocessing
  restores it)

What is accepted here is **both of these together**, not one of them. The lake's window is the
whole ingest rather than one chunk, since a single write is large and cannot be cut up — but
what gets ingested is a version the revert left standing, so that is layer 2 catching up with
layer 1 rather than retracted content coming back.

**Only a run can be killed.** Purges, the backfill and the Lake retry take the claim too, but
none of them checks ownership per write, so releasing their claim does not **stop** them. It
removes the exclusion while the work carries on — worse than the state the kill was for. The
kind of holder recorded on the row (§1) exists for this distinction.

**A revert takes the claim over rather than releasing it.** Split into "stop" and then
"claim", the resource is unowned in between, and a job already waiting can start writing
**over the very content being retracted**. Swapping the owner in one statement leaves no
moment at which the resource is free.

**Emptying goes through the same conditional move, not an unconditional clear.** Uploads take
no claim (§6), so clearing the pointer outright would **delete the winner's content** when a
promote lands after the read — and leave the retracted object parked by nobody and tracked by
nothing. **Losing that move is not a restore**: a revert deletes the preview and the indexed
content right after restoring, and those describe whatever is live, so treating a lost
compare-and-swap as a success **deletes the derivatives of the writer that won**. The loss is
returned as a conflict for the caller to retry.

#### Show that the resource is half-done

A killed run — or an abandoned replacement — leaves
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

- **DB**: `resource_pipeline` records the claim's owner (a run id) and the kind of holder.
  Liveness is read from the running step's `started_at`, so no expiry column is needed
- **Worker**: the pipeline, purge, Lake-retry and backfill handlers take the claim and do
  nothing without it. The step-boundary fence and the version-gate lock are removed (§5)
- **API**: package and draft purges run over HTTP, so they take the claim too (409 for a
  retry when they cannot). Plus routes to report a run's state and to kill it
- **Frontend**: processing state and elapsed time, the kill action, and the purge path
  with its warning
- **Operations**: a hang does not resolve itself; it waits for a decision. Layer 1
  (versions, downloads, replacement) is unaffected, so waiting is the safe direction

**Net effect**: one mechanism is added, and two go — the generation fence (a context
method and three call sites) and the version-gate lock. Defence moves from "a condition
at every write site" to "one check at the entry point", which is a smaller surface to
leave a hole in.

## Open Issues

1. **Measuring the threshold**: 15 minutes comes from the input caps (100MB fetched, 50MB
   of CSV), not from the longest step observed in production. To be tightened once measured
2. ~~**Granularity for bulk jobs**~~: settled (§2). One statement, so no acquisition order
   and no deadlock; one resource held abandons the whole set for a retry
3. ~~**Serializing the Lake retry**~~: settled. Absorbed into the claim (the retry job
   takes one too). What remained — a mid-history version whose preview had been swept — was
   first answered by the version naming that preview (`lake_source_key`), but **that column
   was retired in ADR-046 §4**. Layer 2 now reads the version file directly, so a preview's
   survival has no bearing on an ingest and the question itself is gone
4. ~~**Ordering of the removals**~~: settled. §5 was carried out once every path took the
   claim — the `isSuperseded` fence with its three call sites, and `VERSION_CAPTURE_LOCK`
5. **Resuming after a kill**: a kill frees the claim, so a job already requeued for the same
   resource can take it 30 seconds later and start the same work again. An execution
   generation would close it, but the trigger is narrow (a concurrent job already waiting)
   and resuming does little harm — after a revert it processes the restored content, the
   version gate skips, and it rebuilds the derivatives. Whether to add one is unsettled
6. ~~**`claimResources` does not create the row**~~: settled. Acquisition now mints a missing
   row before taking it. The reason it was held back — a bulk purge carrying hundreds of
   inserts — does not hold: `INSERT ... SELECT ... ON CONFLICT DO NOTHING` is one statement
   whatever the count. Selecting from `resource` keeps an id whose resource is already gone
   from taking the whole set down with it on the foreign key. The insert is not folded into
   the take as a CTE beside it, because **the sub-statements of one statement share a
   snapshot and the UPDATE would not see the inserted rows**; nothing is lost to the gap,
   since a row taken in between comes back as held. The revert's own `ensureClaimable` moved
   into the claim layer and was deleted (`claimFromRun` mints the row too). "No pipeline row"
   is therefore gone: `absent` and a null claim now mean **the resource itself is gone**
7. **A version superseded before it reached layer 2** can never reach it. Eligibility is
   limited to active versions, and admitting superseded ones would let an ingest **replace the
   catalog's current contents with that version** (ii-a is a wholesale replace), making
   retracted content what layer 2 serves. The overtake guard cannot tell the difference — the
   retracted version carries the higher number. An interpretation or ingest that fails and is
   then reverted therefore leaves that version's diff permanently `not-ingested`. Admitting
   them safely needs an ingest-then-roll-back-to-the-previous-snapshot sequence. A version
   superseded **after** reaching layer 2 — the ordinary path — keeps its snapshot and stays
   diffable

## Related ADRs

- ADR-002: SQS over BullMQ (at-least-once delivery is one source of duplicate runs)
- ADR-022: DB polling instead of SQS (withdrawn; also re-examined for correctness)
- ADR-028: Async organization purge with a durable claim (the precedent for this pattern)
- ADR-043: Resource versioning and row-level diff (where these races came from)
