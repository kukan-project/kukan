# ADR-044: Per-Resource Execution Claim

## Status

**Accepted** — implemented 2026-08-03

Limit a resource to one running operation at a time, expressed as a claim on its
`resource_pipeline` row. Pipeline runs and purges share the same claim.

> **The ii-b design revised §4's revert contract on 2026-08-17.** The version state
> `superseded` is dropped, and **a revert now issues the destination's content as a new
> version**. `restoreTo` and `ifLiveRevision` stay; the rule that a `superseded` version cannot
> be named as a destination goes. The claim mechanism itself (§1–§3, §5, §6) is unchanged.
> Reasoning and measurements in `docs/specs/en/phase-versioning-2-ducklake.md` §7.2.
>
> **The publishing revert and the conversion of the rows the old scheme left are built
> (2026-08-19).** Dropping `superseded` from the language of states waits until the conversion
> has nothing left to do.

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

**Purge against a pipeline run — a hole in the purge.** Extract writes the preview to
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
Extract's input is capped at 100MB of CSV, Version is a server-side S3 copy, and Index is
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

#### A revert deletes no versions — it re-issues the content

> **ii-b rewrote this section (2026-08-17, built).** It originally added a fourth state,
> `superseded`, and dropped every version above the destination into it. **The shape is now to
> move versions forward, and `superseded` is dropped.** Reasoning and measurements in
> `docs/specs/en/phase-versioning-2-ducklake.md` §7.2; the state diagram is in ADR-043 §1.1.

**A revert does not restore, it issues a new version holding the destination's content.** An
operator names a version and that content stands as v(N+1). Layer 1 needs nothing new — the
rule "a version takes an object nobody owns, and copies one that is already owned" already
covers this (ADR-043 §1-2).

**What becomes one sentence is layer 1's automatic fallback after a purge — the newest `active`
version**, not the definition of live. New history never produces `superseded`, so it **coincides**
with "the newest version not purged"; rows the old scheme left part the two until the conversion
below has run.

**Live itself is not that sentence.** Live is **the version owning the object the live pointer
names**, which mid-purge can be a `purging` one — and then no `active` version is live at all (the
`isLive` rule, spec §9.6). **Calling both by one name makes the purge confirmation say something
other than what happens.** With no set to
narrow, the "step off everything above the destination" preamble disappears with it.

**What the original was, and why it broke.** Leaving the version stepped off active leaves it
**the highest active version**, which breaks the invariant "the live content is the highest
active version", so everything above the destination was dropped into `superseded`. **That was
never "a record that was rolled back" but a working variable that made the search for "the
newest active version" answer with the destination** — and if versions move forward there is no
search, so there is no set to narrow.

**Then layer 2's write path ruled out `CREATE OR REPLACE`.** The original revert rewrote the
table wholesale and overwrote the destination version row's snapshot id. A whole rewrite is the
write path ii-b rejected (315x on append-mostly data); going through the ingest path writes
deltas. Once a version row's snapshot is written once and never again, moving contents can only
be done by issuing a version.

> **This originally read "the order inverts and the diff silently returns nothing". It no
> longer holds** — the diff compares endpoints and does not depend on snapshot order (measured
> in spec §7.2). **The two reasons left are the write path above and open issue 7 below, and
> both are weaker than the one they replace.**

**Two prices.** Each revert adds a version number and a layer-1 object (a round trip grows them
linearly). And **the purge's fallback destination changes** — revert v5 → v2, issue v6, then
purge v6, and live returns to **v5**, not v2. Read the history as the append-only log it is and
"remove the top and you are back at the previous published state" is the honest reading.
**Content set aside can come back as current** either way, so rather than encoding it in a
state, **the purge confirmation screen says so**.

**Finding where the resource stands is unchanged.** The operator names a version, but "where it
is standing now" is found by hash, because the live pointer names an object and not a version —
**the newest version holding those bytes**. A plain hash match will not do: several versions
may legitimately hold one hash (ADR-046 decision 3), so that answers yes for any of them. The
purge's liveness test asks the same question.

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

| State                            | Answer                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| already at `restoreTo`'s content | the content does not move, and **nothing is cleaned up** (below) |
| the generation matches           | do the work                                                      |
| otherwise                        | 409                                                              |

**"Already at the destination" is asked of the content, not the version number.** Now that a revert
issues a version, live stands on the version carrying the destination's content and never on the
destination itself — asked by number, a resend always finds work to do, takes the claim, and is then
refused over **a generation its own first attempt moved**. What `restoreTo` asks for is bytes and an
interpretation, and comparing those is **the same comparison the version gate makes**: issued again
they would create no version, so there is no change left to record.

**The comparison uses the version gate's own function.** There is one definition of what a version
is (ADR-046 §3). Today its inputs are the hash and the format; in ii-b **the primary key columns
become a third** (spec §6.4 — the key is part of the interpretation, so changing it makes a
version). Writing settled against a fixed list of columns means that on that day **a version
differing only in its key can no longer be restored**: the content matches, settled says so, and
the interpretation never comes back. Grow the gate, and settled grows with it.

**What is restored includes the interpretation.** A version is "those bytes, read this way", so the
version issued **copies the destination's interpretation** — `format` already works that way
(ADR-046 §6), and ii-b's primary key joins it. The resource's current setting moves to the
destination's in the same transaction. **Otherwise settled can never hold**: the issued version
freezes the current reading, which does not match the destination's, and every resend issues another
version (spec §6.4).

**Matching content is not sufficient on its own.** Content repeats (ADR-046 §3), so live can hold
the destination's bytes while standing on **another version's object** — and if that version is
being purged, the object is about to be destroyed. Settled there would leave the resource pointing
at content that is going away, with the revert that would have moved it off told there was nothing
to do. So settled is "the content matches **and** the object live stands on does not belong to a
version being purged".

**No idempotency key, no operation ledger.** Those answer "have I run this operation", where the
question to answer is "is what was asked for what is being served" — and the second is readable
straight off the data. Repeated content is normal (ADR-046 §3), so a resend naming a different
version holding the same bytes also answers "already there", which is right: what was asked for is
what is out.

**A resend does not report the version that was issued.** It issued none, and the number the first
attempt issued need not still be the newest. A caller that wants version numbers reads the history.

| Field       | Type             | First success   | Resend (already there) | Emptying revert |
| ----------- | ---------------- | --------------- | ---------------------- | --------------- |
| `restored`  | `number \| null` | the destination | the destination        | `null`          |
| `published` | `number \| null` | the new version | `null`                 | `null`          |

**`published` is "the version this call issued", not "the version holding the destination's
content".** That is why a resend does not answer with the first attempt's number: a caller would
read it as the newest, and another publication in between makes it not.

A version number cannot serve as the generation: **content can be live with no version holding
it** — an upload no run has captured — so `resource.content_revision` is re-minted by every
writer of the live pointer. The storage key would identify it too, but naming internal objects
in a response is what `publicResourceColumns` exists to prevent, so the generation is its own
opaque value.

**The destination is validated.** Left unchecked, naming a missing or `purged` version moves
the contents and then restores a different version, or none, and reports success.

> **The rule refusing a `superseded` destination goes with the state.** Stepping back onto
> content an earlier revert set aside used to be refused as redo, but that constraint existed
> only because a revert **renumbered** versions. Once versions move forward, "issue that
> content again" is unambiguous and there is nothing to refuse. **Any surviving version can be
> named.**

**Existing `superseded` rows are converted, not left alone.** Now that a revert issues a version,
the rows the old scheme left behind are **moved to the shape a new-scheme revert would have
produced** — the versions it set aside go back to `active`, and the live content is issued as a new
version. One claim per resource.

**The unit is the resource, not the version, and there are no exceptions.** Every resource holding
even one `superseded` row is processed. Exclude one shape and its `superseded` rows stay forever,
and the condition for collapsing to three states is never met. What happens is decided by one
thing: **who owns the live object** (the flip does not change that answer, so it can be asked
either side of the issue).

| The live object              | What the conversion issues                             |
| ---------------------------- | ------------------------------------------------------ |
| Owned by the topmost version | Nothing                                                |
| Owned by a lower version     | A **copy** of its content, as a new version            |
| Owned by no version          | **That object, taken over by a new version** (no copy) |
| The pointer is empty         | Nothing (there is nothing to issue)                    |

**The third row was excluded at first.** The reason given was that there is no version to issue
from; what an issue needs is not a source **version** but its **bytes**, and the live pointer names
them.

**Not copying when nobody owns it is what the rule already says** — "a version takes an object
nobody owns, and copies one that is already owned" (ADR-043 §1-2). The pointer does not move
either. That version's `restored_from` cannot be written — several versions can hold the same
bytes, so the hash does not settle which one this content came from — so it is null. **`origin`
records how the bytes got here**, so it stays the fetch or upload that published the object;
calling it a revert puts a claim in the history that nothing supports.

**This shape cannot be excluded because it coexists with the old rows.** An unchanged re-fetch
writes a fresh key every time and creates no version, so a resource holding `superseded` rows
**reaches this shape by being left alone**.

**The hash and the size are measured, not taken from the row.** `upload-complete` accepted any
string as a hash for a time, and `size` can be a number the client claimed. This is the branch with
**no copy to read instead**, and what it records becomes what version identity and the live guess
compare against; a disagreement is settled by correcting the resource row.

**The conversion puts an end to `superseded`.** A converted resource holds no such row and its
topmost version owns live, which makes the misidentification that runs through old rows — a
retained row above live stealing the guess for an unowned live object — unreachable. What can
outrank live afterwards is `active`, or the single `purging` row a resource may hold, and that one
is the version being purged, so the guess lands on it correctly.

**It does not follow that the guess is always right for an unowned live object.** The gate is not
the only path that creates no version: **a failed version create** leaves live unowned too, since
it does not fail the run. Should those bytes coincide with an older version's, the guess names that
older version and a purge of it changes what is served. **The conversion does not address this** —
only the shape where a retained row takes the guess.

**Leaving them alone was the first answer, and its reason was wrong.** It said returning them to
`active` moves live; live is **the owner of the object the pointer names**, not a version's rank, so
changing the state does not move the pointer. What moves is the purge fallback — **the change this
same section already accepted**.

**And leaving them alone puts a permanent two-regime burden on every reader.** A predicate over
version state then has to be right about the new world and the old one at once, and in
implementation the count of fixes equalled the count of new holes:

| Predicate tried                        | The hole it opened                                          |
| -------------------------------------- | ----------------------------------------------------------- |
| Widen to "not a tombstone"             | A retained row becomes the latest-version label, and live   |
| Exclude `superseded`                   | It returns the moment a claim moves it to `purging`         |
| A different set per caller             | The purge over-includes, the revert under-includes          |
| The claim records liveness             | The record goes stale and deletes a freshly uploaded object |
| Fence the record by pointer generation | `READ COMMITTED` puts the two reads in different snapshots  |
| A compat branch for rows without one   | Reopens a mis-identification already closed                 |

**And the readers keep coming** (ii-b's key, ii-c's settled types), so the shape does not converge.
**It is a property of the data, not of the predicate.**

**The conversion cannot be written in SQL.** Issuing content as a new version needs an object copy,
so it is a backfill like ADR-043's v1 pass (claims each resource, idempotent, resumable).

**The issue goes first and the flip second.** This first said the two go in one transaction, which
was true of the order it assumed. **Reverse them and the broken window never opens** — once the
content is issued, the topmost version owns live, and both the label and what is served point at
it. `superseded` rows still present are merely counted as content being served, which is not wrong.
"Label says the higher version, serving says the lower" is what the _flip-first_ order shows.

**Whether to issue is a question the flip does not change, which is what lets them be split.** It
asks whether the topmost version not purged owns the live object, and the flip moves neither
version numbers nor tombstones. A conversion cut off partway resumes by asking again: with the
content issued the answer is no, and only the flip is left.

**And issuing closes both old-data defects for that resource on its own.** Both need the hash guess
to be in play, and it is not once an issued version owns live. The flip is then only tidying the
state away.

**Copying an interpretation into the taking-over branch needs proof it was built from the bytes
that are live now** (a matching `sourceHash`, the same condition as the v1 pass). A failed
interpretation keeps the previous result, so an unchecked copy pins another content's columns onto
this version. **With a zero-column schema the damage is permanent**: that version leaves the
layer-2 sweep for good. Without the proof it goes in empty and an ordinary re-interpretation fills
it.

**Two shapes never finish converting.** Both are operational rather than structural and both show
in the outstanding count: a destination wedged in `purging` (the issue goes on raising
`ConflictError`), and a live object missing from storage (the measurement throws). **Nor does one
run necessarily reach zero** — a resource a run was holding is skipped and not revisited in that
pass, and nothing re-enqueues, so the operator presses again.

**The flip also changes what layer 2 can see.** Both the ingest predicate and the set a table may
stand on filter on `active`, so a set-aside version becomes a candidate the moment it flips. Just
after a conversion the newest active version holding a snapshot can be one of those, while live is
the version just issued and not yet ingested — layer 2 standing, briefly, on content the resource
does not serve. The next ingest settles it.

**Until the conversion has run, the readers keep the old predicates.** Code written for three states
counts a retained row as content being served, so the order cannot be reversed.

**Afterwards the questions collapse into one**: live is the pointer's owner, a purge falls back to
the highest `active`, and there are three states. No exceptions left.

**The response keeps answering "the destination that was named".** A revert already returns the
destination's version number, and that meaning does not change. What changes is that a **published**
version now exists alongside the destination, so its number is added as a separate field. Making the
same response shape point at a different number is something an older caller cannot notice.

**How they read until then, for the record.** While retained, a `superseded` row is **not an
automatic target** (the purge fallback and layer 2's stand both read `active`) and **keeps every
other right** — downloadable, listed in the history, an endpoint of a diff, purgeable, and nameable
in `restoreTo`. Writing the survival side as `active` expires its snapshot — its diffs go — and
refuses to purge it, making the version most likely to need destroying the one that cannot be.

**The content is not lost.** A version stepped down from live keeps its file and stays
downloadable (only `purged` is refused). Someone who reverted by mistake just names the right
version again — what comes back is **a new version**, not the old one standing back up.

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
onto content the user was never shown. The pair's lifetime is **separate from the dialog's** (a
revert that left cleanup behind has to keep it for the retry, and putting it on the same state
hides the retry behind the modal). **It is discarded only on a 409** — a network exception is
"unknown whether it happened", but a 409 is settled, and the same pair would only be refused
again.

**Known limitation: a version stepped down before it reached layer 2 can never reach it**
(open issue 7 — resolved by ii-b).

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
replaces the file while a run is in flight**. That is what Fetch's `superseded` now means
(**a `FetchResult` status, not a version state**. The version state of the same name is dropped
in §4; this one stays).

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

1. **Measuring the threshold**: 15 minutes comes from the input caps (100MB fetched, 100MB
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
7. ~~**A version superseded before it reached layer 2**~~: **resolved by the ii-b design
   (2026-08-17, built).**

   Eligibility is limited to active versions, and admitting superseded ones would let an ingest
   **replace the catalog's current contents with that version**, making retracted content what
   layer 2 serves. The overtake guard cannot tell the difference — the retracted version
   carries the higher number. An interpretation or ingest that failed and was then reverted
   therefore left that version's diff permanently `not-ingested`.

   **Dropping `superseded` leaves no room for the state to arise** (§4). A revert issues a new
   version instead of stepping one down, so a version awaiting ingest stays `active` and waits
   its turn, and the sweep picks it up in version order. The
   ingest-then-roll-back-to-the-previous-snapshot column is not needed either

## Related ADRs

- ADR-002: SQS over BullMQ (at-least-once delivery is one source of duplicate runs)
- ADR-022: DB polling instead of SQS (withdrawn; also re-examined for correctness)
- ADR-028: Async organization purge with a durable claim (the precedent for this pattern)
- ADR-043: Resource versioning and row-level diff (where these races came from)
