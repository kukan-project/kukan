# ADR-047: When what arrives contradicts what was declared, do not replace the canonical copy

## Status

**Proposed**

When a fetch from an external URL returns something that plainly contradicts the kind of thing
the resource declares itself to be, **fail without creating a version**. The canonical copy
lives at the registered URL, so there is no need to keep the bytes. And record redirects
wherever they happen, successes included, so they can be surfaced — a URL that redirects is
already out of date, and is something to fix.

Decided ahead of implementation because it touches ADR-043 (versions), ADR-046 (canonical copy
separated from its interpretation) and ADR-044 (reverting) at once.

## Context

### 1. A blanket forward on site closure is ordinary operations, not an edge case

When a publisher is reorganised, merged or shut down, forwarding every URL on the old domain to
the new site's front page is a common configuration. `/data/foo.csv` and `/data/bar.csv` both
land on `https://newsite.example.jp/`, indistinguishably.

What has happened is not that the resource **moved**; it is that the resource is **gone**. The
target does not hold that data. HTTP nonetheless answers 200.

### 2. Today's path carries this all the way through

1. The health check sends a HEAD, follows the redirect, and gets a 200
2. **A 200 records `health_status = 'ok'`** (`head-request.ts`)
3. The target's `etag` differs from the stored one, so `changed = true`
4. `changed` enqueues a pipeline run (`check-batch.ts`)
5. Fetch reads only `content-length`, so it downloads the HTML as it stands
6. The hash differs, so **a new version is created** — permanent, per ADR-043
7. The live pointer moves and Index feeds the HTML text to the search index

A resource registered as CSV is now an HTML front page. Search returns that page's wording. The
preview and schema are gone, or no longer mean anything.

### 3. The health check pulls the trigger

Note steps 3 and 4. The health check records the link as healthy and then, **on the strength of
that same healthiness (a validator changed), orders a re-fetch**. A mechanism meant to watch is
what starts the damage.

Publishers that send no validators are covered by the periodic full re-fetch, so they reach the
same path later.

### 4. The design knows this failure; nothing notices it

The pipeline already says (ADR-044 §4):

> _for a resource reverted because its URL served the wrong thing that run publishes it again_

The notion of "its URL served the wrong thing" exists, and so does a way to revert. The comment
even warns that a plain retry **publishes the wrong thing again**.

**There is an undo; there is no detection.** That is the gap to close.

### 5. The tension with ADR-046

ADR-046 settled the canonical copy first and interpreted it afterwards. A version is decided
from the bytes alone, so a step that fails leaves work a later run can redo identically.

But "these bytes are plainly not this resource" is a judgement on the **interpretation side**.
By the time it can be made, the version already exists. This ADR decides how to protect the
canonical copy without disturbing that order.

## Signals available

| Signal                                                           | Strength                      | Cost               | False positives                                                                               |
| ---------------------------------------------------------------- | ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| **The body starts `<!DOCTYPE html` / `<html`**                   | Strongest                     | ~free              | Almost none. HTML for a resource declaring CSV / JSON / XML / GeoJSON is near-certainly wrong |
| **The redirect target's path collapsed** (`/data/foo.csv` → `/`) | Strong                        | free               | Few. Clearly distinguishable from a move to `/opendata/2026/foo.csv`                          |
| Content-Type disagreeing with the declared format                | Medium                        | free               | **Many.** Government servers routinely serve CSV as `text/html` or `application/octet-stream` |
| **Many resources converging on one URL**                         | Strongest (what a human uses) | needs a batch pass | Almost none. Fifty resources landing on the same target is not fifty individual moves         |
| Size or hash changing                                            | Useless                       | —                  | Indistinguishable from an ordinary update                                                     |

**Content-Type must not be the gate on its own.** It would stop a great many working publishers.

Checking the leading bytes and the shape of the redirect covers most of it in practice.
Convergence cannot be judged from a single fetch, so it is handled separately.

## Options considered

### A) Leave it as it is

Take what arrives as canonical, and revert when it turns out wrong (ADR-044 §4).

Reverting after the fact **only works when someone notices**. In a data catalog, "the content
was quietly swapped" is exactly the kind of breakage that reaches users unnoticed. Versions are
permanent, so the record survives the revert. Not taken.

### B) Stop in Fetch, before the version

End with `error` when the declared format and the leading bytes contradict each other, before
any version is created.

**For a URL-registered resource the canonical copy is on the other side.** What KUKAN holds is a
duplicate, not the only copy, so there is no reason to keep the bytes of a fetch that was
refused — anyone who wants to see them opens the URL. This is the decisive difference from an
uploaded resource, where KUKAN's copy _is_ the canonical one and the argument would not hold.
Uploads do not redirect, so they are out of scope here anyway.

An `error` appears in the existing resource and pipeline listings. **An operator sees it without
going to look.**

### C) Create the version, but do not move the live pointer

The bytes are recorded and not lost. The resource keeps its previous content while the
disagreement is presented for someone to judge.

**Nobody finds it.** A held version is visible only to someone who went looking for it. From the
catalog's surface it is indistinguishable from nothing having happened, and the stale content
goes on being served. A decision meant to avoid breaking quietly instead accumulates quietly.

It also needs a state to express the hold, a listing to surface it, and an operation to promote
a held version — **three things B does not need**.

And it distorts what adoption means. If the publisher really did switch to HTML, the right
correction is not "adopt an HTML version under a CSV label" but **fixing the declared format**.
C's promote action offers a way forward that keeps the wrong label.

### D) Fix only the health check

Stop answering `ok` and the re-fetch is never ordered.

Half a fix. Publishers with no validators are covered by the periodic full re-fetch, which takes
the same path, as does a user pressing reprocess. The health check does need fixing; it is not
enough on its own.

## Decision

### 1. Fail without creating a version when what arrived contradicts what was declared (option B)

Leave the live side on its previous content and end the pipeline in `error`, carrying both the
disagreement and what actually arrived (the final URL, the kind that was recognised).

**The bytes are not kept.** The canonical copy is at the registered URL and can be fetched
again. There is no reason to mint a permanent version (ADR-043) for something already decided
against.

If the publisher genuinely switched to another kind, the correction is to **fix the declared
format and reprocess**. That needs no new affordance, and it is the repair that should happen
anyway: the label and the content agreeing again.

**This is not limited to fetches that followed a redirect.** A publisher swapping the content
behind the same URL is treated the same way. Redirects are the likeliest route, not the cause.

Uploaded resources are out of scope. They do not redirect, and KUKAN's copy is the only
canonical one, so "it can be fetched again" does not hold.

### 2. Judge on the leading bytes and the shape of the redirect

- The declared format is textual (CSV / TSV / JSON / GeoJSON / XML / MD) and the leading bytes
  are recognisably HTML
- The fetch followed a redirect and the final URL has lost its filename (the path collapsed to
  `/`)

Content-Type is **corroboration only**, never the gate by itself.

Fetch owns the judgement. It does not affect what creates a version (ADR-046 decision 3) — the
rule that identical bytes under an identical interpretation make no new version stands.

This does not collide with ADR-046's "layer 1 contains no interpretation". What is decided here
is not **what goes onto a version** but **whether a version may be made at all**, and the
judgement is recorded nowhere on it. Layer 1 stays free of interpretation.

### 3. Have the health check record the final URL, and subdivide `ok`

The final URL is currently kept nowhere. **An operator has no way to see where a link actually
goes.** Record it whenever a redirect was followed.

A 200 that lands on a disagreement of the kind above gets a state distinct from `ok`. Not
`error` — the move may be legitimate and a person has to decide.

**No re-fetch is ordered from `changed` in that state.** The trigger is disarmed.

### 4. Record redirects even when the fetch succeeded, and surface them

**If a fetch is being redirected, the registered URL is already stale.** A 301 or 308 says so in
as many words: moved permanently, update your references. The catalog currently absorbs that
silently, pays the extra round trip on every fetch, and tells nobody.

Record it whether or not anything failed. Three things per fetch:

- the **final URL** (the same one decision 3 records)
- the **hop count**
- whether any hop was **permanent** (301 / 308)

Then keep a listing of resources whose URL redirects. Permanent ones rank first, but
**temporary ones are not hidden**: publishers use 302 for permanent moves routinely, so the
status code alone cannot sort them. `http` → `https` and apex → `www`, where the fix is
unambiguous, belong in the same listing.

**Do not rewrite the URL automatically.** The catalog silently editing metadata a user entered
is the same class of failure this ADR exists to prevent. Propose it; let a person apply it.

### 5. Do not follow fewer redirects

"A redirect means it should be fixed" does not lead to "stop following them". Lowering the limit
only turns working resources into unexplained failures, and creates no pressure to fix the URL.
A legitimate `http` → `https` → `www` → path chain already exceeds three hops.

**The lever is visibility.** Keep following; show what is happening.

### 6. Detect convergence later, not per fetch

"Many resources converging on one URL" is the highest-confidence signal, and no single fetch can
see it. Record the final URL, and aggregate separately.

This ADR settles the recording; the detection is an open issue.

Note that decision 4 supplies the same data. **A blanket forward is "many resources arriving at
one final URL"; a site migration is "many resources arriving at one host by different paths"** —
group the recorded final URLs by (origin host → final host) and both fall out of one listing.
There is no need for two mechanisms.

## Consequences

- **The catalog's canonical copy stops being replaced silently at a publisher's convenience.**
  That is the point
- **Failures appear in the listings that already exist.** No new state, no new screen
- False positives are possible. If a publisher really did switch, **fixing the declared format
  and reprocessing** is the extra step — and it is the correction that should happen anyway
- The fetched bytes are not kept. An operator who wants to see them opens the URL. The decision
  is scoped to URL-registered resources, which is what makes that true
- The health check gains a state, so the column's domain and the UI both change
- **Every resource carries redirect bookkeeping.** Final URL, hop count and a permanence flag —
  tens of bytes each, rewritten per fetch, one row per fetch
- The redirecting-URL listing is **new work for operators**. Ignoring it breaks nothing, but a
  backlog that grows stops meaning anything. It belongs beside the existing health-check view
- The leading-byte check runs while Fetch is already streaming, so it costs no extra read

## Open issues

- **How much structure the failure carries.** Prose in `error`, or a machine-readable reason?
  The convergence detection below is easier to aggregate with the latter
- **Detecting convergence.** How many resources on one final URL constitute a blanket forward.
  The threshold is an operational question
- **How the URL update is offered.** In bulk from the listing, or one at a time? Restricting bulk
  to permanent redirects is tempting, but with publishers using 302 for permanent moves, the
  status code alone is a shaky basis for automating anything
- **Which formats to judge.** PDFs and images are recognisable from their leading bytes too, but
  the harm when they turn into HTML is smaller than for textual formats. How far to extend
- **ZIP contents.** A resource declaring ZIP that is answered with HTML fails manifest
  generation, so the existing path catches it. Worth confirming it needs nothing more

## Related ADRs

- ADR-043 (resource versioning) — versions being permanent, and the layering
- ADR-044 (per-resource execution claim) — §4's revert, where "its URL served the wrong thing"
  already appears
- ADR-046 (separating the canonical copy from its interpretation) — a version decided from the
  bytes alone
- ADR-021 (resource content indexing) — the route by which wrong content reaches the search index
