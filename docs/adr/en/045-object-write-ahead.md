# ADR-045: Recording storage objects before they exist

## Status

**Proposed**

Record a key in the ledger before the object is created, and remove the record once something
points at it. A sweep reclaims whatever a crash left behind. Deletion happens only after
confirming no pointer references the key — and when one does, the record goes instead of the
object. The writer declares when its record may be reclaimed.

## Context

Seven writes create an object **before** recording it. If the process dies in that window,
the object is left **referenced by nothing, with no path that reclaims it**.

| Write                              | Prefix       | Reference                                |
| ---------------------------------- | ------------ | ---------------------------------------- |
| Fetch's download                   | `resources/` | `resource.storage_key`                   |
| Extract's preview Parquet          | `previews/`  | `resource_pipeline.preview_key`          |
| Extract's ZIP manifest             | `previews/`  | `resource_pipeline.preview_key`          |
| Index's text head (ADR-040)        | `previews/`  | `resource_pipeline.metadata.textHeadKey` |
| Version capture's copy             | `versions/`  | `resource_version.storage_key`           |
| The backfill's copy                | `versions/`  | `resource_version.storage_key`           |
| A version purge's rollback restore | `resources/` | `resource.storage_key`                   |

Each has the same window: the copy or upload succeeds, and the process dies before the
database write. Today's sweep only deletes keys parked in `orphaned_object`, and a key born
in that window never gets there. **It stays forever.**

The impact is **a storage leak only**. An unreachable object remains; correctness is
unaffected. It is still billed, though — and it is still content that was supposed to be gone.

### Three mechanisms already here

Before inventing anything, we checked what already surrounds this problem. **The shape to
adopt is already in the repository.**

**Write-ahead — browser uploads only.** `prepareForUpload` writes
`resource.pending_storage_key` **before** calling `storage.upload`, and
`expirePendingUploads` reclaims abandoned keys once their TTL passes. The one path that does
_not_ have this window is already protected this way.

**Parking after the fact — `orphaned_object`.** A ledger of keys a writer **replaced**,
drained by `sweepOrphanedObjects` once the retention passes. A parked key is unreferenced by
construction, so the sweep may delete unconditionally.

**Reconciliation — `lake/` only.** `ducklake_delete_orphaned_files` compares the catalog
against the file listing and removes what it never tracked (ADR-043, with a 24-hour
retention). But that is **a DuckDB built-in**, not a mechanism we own. It works because
DuckLake knows both the catalog and the file layout.

## Options considered

### A) Write-ahead

Put the key in the ledger before uploading; remove it once the pointer is committed. A
record left behind is what the sweep reclaims.

- **For**: reuses the existing ledger, sweep and retention. The question stays local — **did
  this write complete?** One INSERT on the execution path (removal rides along on the
  statement that moves the pointer, which already inserts into `orphaned_object`).
- **Against**: **it inverts the failure direction.** Miss the removal and the sweep deletes a
  **live object**. A leak (harmless) becomes data loss (severe).

### B) Periodic reconciliation against the storage listing

Enumerate each prefix and reclaim objects no pointer references.

- **For**: nothing on the execution path, and nothing can be missed — the listing is the truth.
- **Against**: references live in several places (`resource.storage_key`,
  `resource.pending_storage_key`, `resource_version.storage_key`,
  `resource_pipeline.preview_key`, `metadata.textHeadKey`). **Add a pointer column later and
  forget the reconciler, and it deletes what that column referenced.** Exhaustiveness becomes
  a permanent precondition, and the cost of breaking it is data loss. Enumeration also costs
  real requests on a large bucket.

### C) Do nothing

The leak does not affect correctness. But ADR-044 has just closed the window where "content
survives a deletion that claimed to erase it" — tolerating the same residue from a different
cause does not hold together.

## Decision

**A, with B's question asked immediately before deletion.**

Both options carry the same shape of risk: **whatever deletes has to know what is
referenced.** They differ in how the question is framed. A narrows it to "did this write
complete?"; B asks a global invariant — "is this object referenced by anything?" — every
time. The first is harder to break.

And A's one weakness (a missed removal is fatal) **disappears once B's question is asked
once, just before deleting**. Write-ahead produces the candidates — cheap, precise, no
listing — and a pointer check decides whether they may go. B is used as a predicate over
candidates, not as a full scan.

### 1. Where the record lives

`orphaned_object`, unchanged as a table. No new one.

Keys in it come to mean two things ("replaced" and "about to be created"), but **the sweep
reduces both to the same question**: does any pointer reference this object now?

### 2. The writer declares when a record may be reclaimed

Stop judging by `orphaned_at` against one global retention, and **add an `expires_at`
column**.

The two kinds share a table but not a reason for waiting. Parking waits for readers that
already resolved the old key to finish; a write-ahead record waits out the longest time its
write could still be in progress. Both are an hour today, but that is the values coinciding
— **tune one for its own reason and the other moves with it.**

ADR-044 gave every claimer one `CLAIM_STALE_AFTER_MS` precisely because they were asking the
same question. Here the questions differ, so the values separate. One column covers it, and
the sweep becomes a uniform `expires_at < NOW()`.

### 3. The sweep's predicate

For keys past their deadline, check the reference sources before deleting. Five to begin
with, six now (`resource_version.lake_source_key` joined them — ADR-043 §6-6).

**If something references the key, delete the record rather than the object.** A referenced
key means that write completed, so the record is a leftover. Keeping it would have the sweep
re-decide the same key every hour, forever. **This one move turns write-ahead's only danger —
a missed removal deleting live data — into self-repair.**

Parked keys are referenced by none of them, so the predicate changes almost nothing about
today's behaviour — **it matters only for write-ahead keys.**

With one exception. `resource_version.lake_source_key` (ADR-043 §6-6) is a reference meant
to be **released later**. While it names a parked key the record is what goes, so **the
statement that drops the pointer has to park the key again, in the same statement** — or
the object is left with neither a pointer nor a record, which is the state this ledger
exists to prevent.

### 4. Where the record is removed

On the statement that moves the pointer. Those statements already insert into
`orphaned_object` (parking the key they replace), so this is a DELETE in the same statement.
**No extra round trip.**

The two version inserts (pipeline and backfill) are the exception — they do not touch
`orphaned_object` today, so the DELETE is new there.

### 5. `lake/` stays out

DuckLake's built-in already fills this role (ADR-043, #176). It is the thing that knows the
catalog and the file layout; there is no reason to reimplement that from outside. **No
generalized per-prefix reconciliation job.**

## What this does not replace

**`pending_storage_key` stays.**

It looks like the same mechanism — and it is why browser uploads are not among the seven
windows. But the column does four jobs, and only the first overlaps.

| Job                                                                     | Replaced by this ADR? |
| ----------------------------------------------------------------------- | --------------------- |
| The write-ahead record itself                                           | yes (duplicated)      |
| CAS — promote only while that key is still the pending one (ADR-044 §6) | no                    |
| Carrying `pending_metadata` (filename / contentType / name / format)    | no                    |
| State across two HTTP requests (remembering the key that was issued)    | no                    |

`orphaned_object` holds a key and a deadline: no resource association, no metadata, no
compare-and-swap semantics.

Even the overlapping job differs in its deadline. A browser upload's TTL is **24 hours**, so
a slow client is not cut off, where a server-side write finishes in minutes. Having the
writer declare `expires_at` (§2) is what keeps differences like that out of a single constant.

## Consequences

- **DB**: `expires_at` added to `orphaned_object` (one migration; existing rows backfilled as
  `orphaned_at + 1 hour`). The sweep's predicate adds the pointer check, which needs an
  expression index on `metadata->>'textHeadKey'`
- **Worker / API**: one INSERT added at each of the seven creation sites; removal rides on
  existing statements (new only at the two version inserts)
- **Operations**: leaks stop being permanent. The sweep logs how many records it dropped
  because something still referenced the key, so a missed removal is observable rather than
  silent

**Net effect**: one round trip on the execution path buys the end of objects with no path
back. No new mechanism — one column on the ledger and sweep already in place.

## Open issues

1. **The existing leak**: this protects future writes and **does not reclaim what is already
   stranded**. A one-off reconciliation (option B, run once by hand) is still needed
2. **Measuring the check**: every reference source, against batches of 5000 keys. Expected to
   be fine on indexes, but not measured
3. **Two kinds of `previews/`**: the preview Parquet and the text head share a prefix and
   differ only in what references them. The predicate looks at both, so this works — but
   separate prefixes might read better

## Related ADRs

- ADR-043: Resource versioning and row-level diff (where `orphaned_object` and parking come from)
- ADR-044: Per-resource execution claim (closed the same residue caused by races; this one is
  the crash half)
