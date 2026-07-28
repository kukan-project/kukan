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
constraint already exists).

It covers **both pipeline runs and purges**. Both rewrite the resource's content, so they
must exclude each other. "No new version until the purge finishes" follows from that.

### 2. Taking the claim

A run takes the claim first. If a live claim is already held it **does not start**. The
job completes rather than failing, and leaves the queue: another run already owns the
content, so retrying means nothing.

The claim is taken in one statement, never read-then-write.

### 3. Releasing the claim — three paths

**Normal completion**: a run that finishes releases it.

**Automatic takeover**: a claim whose steps have not progressed for a set period can be
taken by another run. This is what makes a dead worker (OOM, task replacement, deploy)
self-healing; without it every redeploy would leave stuck claims for someone to clear by
hand. Progress is `resource_pipeline.updated`, which each step advances.

**Manual kill**: an operator can stop a run without waiting for the threshold — an
external URL that is known not to be answering has no reason to wait it out. A kill
releases the claim and marks that run cancelled.

Takeover and kill are not alternatives. **Both a state worth judging and a way to act on
that judgement are needed.**

### 4. What an operator sees and does

Surface that a resource is being processed, and for how long. An operator decides when a
run has gone on too long and kills it.

If the content is broken beyond a kill — it cannot be ingested into layer 2, say — offer
to **purge that version**, reusing the existing mechanism (sysadmin only, reason required,
audit logged).

A purge also deletes the layer-1 version file, so **that version stops being
downloadable**. The screen offering it must say so and ask for confirmation.

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

The condition itself stops firing under a claim, but the statement also exists to move the
pointer, hash and size **together**. It is not purely a concurrency mechanism, so dropping
the condition would not simplify it.

**Pending-upload atomicity**

Two HTTP requests racing, touching neither the pipeline nor a purge. Outside the claim's
scope, and remains a problem at its own layer.

## Consequences

- **DB**: `resource_pipeline` needs enough to express the claim's holder and liveness.
  Whether `status` / `updated` suffice or a dedicated column is warranted is an
  implementation decision
- **Worker**: the pipeline and purge handlers take the claim and do nothing without it.
  The step-boundary fence and the version-capture lock are removed (§5)
- **API**: routes to report a run's state and to kill it
- **Frontend**: processing state and elapsed time, the kill action, and the purge path
  with its warning
- **Operations**: a hang does not resolve itself; it waits for a decision. Layer 1
  (versions, downloads, replacement) is unaffected, so waiting is the safe direction

**Net effect**: one mechanism is added, and two go — the generation fence (a context
method and three call sites) and the version-capture lock. Defence moves from "a condition
at every write site" to "one check at the entry point", which is a smaller surface to
leave a hole in.

## Open Issues

1. **The takeover threshold**: how long "no step progress" has to last. Derived from the
   fetch size cap (100MB) and how long Extract takes. Whether it is configurable is also open
2. **How the claim is expressed**: whether `status = 'processing'` plus `updated` is
   enough, or the holder (a run id) has to be recorded. A taken-over run and the run that
   took it must be distinguishable
3. **Bulk jobs** (backfill, reindex): how they relate to a per-resource claim — whether
   they take each resource's claim or are treated separately
4. **Serializing the Lake retry**: expected to be absorbed here, but what to do
   once a mid-history version's preview has been swept (give up / purge) is unsettled
5. **Ordering of the removals**: §5 comes after the claim lands. Removing first would
   leave nothing in place until it does

## Related ADRs

- ADR-002: SQS over BullMQ (at-least-once delivery is one source of duplicate runs)
- ADR-022: DB polling instead of SQS (withdrawn; also re-examined for correctness)
- ADR-028: Async organization purge with a durable claim (the precedent for this pattern)
- ADR-043: Resource versioning and row-level diff (where these races came from)
