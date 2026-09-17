# ADR-054: Embed per resource — answering "which table do I open?"

## Status

**Accepted** — implemented 2026-09-17. Measured offline already (ADR-034, "The unit of
embedding" and "Settling the fusion parameters"). **This supersedes only the part of ADR-034
that fixes the unit of embedding.** The store (pgvector alone), the fusion (RRF in the service
layer), how the similarity floor resolves, and the golden-set practice all stand as written
there.

Move the vector from one per package to one per resource, and carry **which resource matched**
into the result. This resolves ADR-034's open issue 4 (how to present a vector hit; extending
`matchSource`).

## Context

### 1. People looking for data open a table

The catalogue lists datasets, but **what a reader finally opens is one table.** 「公金管理実績」
holds nineteen sheets and only 「P1 内訳 基金」 answers anything; 「美容所」 holds five CSVs and
the one that answers 「新しくオープンした美容室を知りたい」 is the **newly-opened** list, not the
**closed** one.

### 2. A package vector does not compute that question

**This is a capability, not an accuracy.** A centroid holds no per-resource score, so no amount
of tuning produces "which resource". ADR-034's open issue 4 — "vector hits cannot be
highlighted" — is a symptom of the same absence.

Measured (ADR-034, "The unit of embedding"; local, 166 packages / 481 resources, Cohere v4):

| Query                              | Resource chosen          | Ranked last in that package |
| ---------------------------------- | ------------------------ | --------------------------- |
| 新しくオープンした美容室を知りたい | **新規**施設一覧 0.553   | **廃止**施設一覧 0.398      |
| 汚水はどうやって処理されている?    | 流入水質・放流水質 0.388 | ダイオキシン類測定 0.348    |

Across relevant packages holding three or more resources, the best one stands 0.038–0.047 above
that package's mean. **A centroid erases exactly that difference.**

### 3. There was no instrument for it

The golden set's answers are package names, so "which table" was never scored. Adding
`relevantResources` to the harness and taking a baseline:

```
resources surfaced (keyword → hybrid), 3 queries:
  synonym  recall   0%→  0%   MRR 0.00→0.00
  natural  recall   0%→  0%   MRR 0.00→0.00
```

**Not one relevant resource is surfaced on any of the three.** For 「新しくオープンした美容室を
知りたい」 the right dataset ranks **first** and arrives as `matchSource: 'semantic'` with an
empty `matchedResources`. Package ranking reaches 95% nDCG on `natural`; which table to open is
not shown at all.

**The ranking got better. A different question was going unanswered.**

## Decision

### 1. The model: a resource is hit and its package comes along — once

The ranking unit is the resource; **the display unit is the package**, placed at the position of
its best resource. No package appears twice (what search engines call collapsing).

**A package's own metadata match stays a signal of its own.** Searching by a dataset's name is a
legitimate act, and not degrading it is ADR-034 decision 8's shipping condition. The BM25 leg
already works this way: a match on the parent document's `title` / `notes` scores directly, and
`has_child` (resource, content) adds on top with `score_mode: 'max'`.

> **The existing `score_mode: 'max'` is this model, implemented on the BM25 leg.** This ADR runs
> the same model through the vector leg.

### 2. The vector belongs to the resource; the package keeps none

Put `embedding` / `embedding_model` / `embedding_hash` on `resource`, shaped as they are on
`package` (ADR-034 decision 2's pgvector-only store carries over).

**`package.embedding` goes.** Under decision 1 **nothing queries a package vector.** Maintaining
something nothing reads makes "which do we search" and "how do we mix them" a permanent fork, and
doubles both the re-embedding and the `embedding_hash` comparison.

The measured exposure was zero: of 166 local packages, **none holds zero resources.** No package
drops out of vector search.

### 3. What is embedded is the package's title and tags, plus the resource itself

```
package title / tags                         … first, up to what the resource's reserve (2,000 chars) leaves
resource section / name / description / abstract … the reserve for certain, and whatever is left over
```

**`notes` stays out.** The morning's decision had it in — with the package vector gone it
would otherwise exist in no vector, and the fused difference was 0.4 of a query. **Measured
against what this ADR is for, that reversed.** Fused nDCG only ever scored the package ranking,
not which table gets opened.

| Package-side material (resource unit, λ=2 / K=10 / floor 0.25) | word P@1 | separation 3–4 / 5–9 | fused word / overall |
| -------------------------------------------------------------- | -------: | -------------------: | -------------------: |
| title + tags + notes                                           |      67% |        0.039 / 0.027 |              69 / 90 |
| **title + tags**                                               |      50% |    **0.047 / 0.039** |          **72 / 90** |
| none (resource alone)                                          |      50% |        0.061 / 0.045 |              72 / 90 |
| title + tags + notes, labelled (「データセット:」…)            |      50% |        0.034 / 0.029 |              69 / 90 |
| title + tags + notes, resource first                           |      50% |        0.048 / 0.037 |              66 / 89 |

"Separation" is how far the best resource of a relevant package (three or more resources) stands
above that package's mean — the direct measure of **whether the right table is being picked**.
The more `notes`, the more labels, the more alike a package's siblings become: **words every
resource shares erase what tells them apart.** What `notes` buys is one word query's P@1
(「ボーナス」, joined through the notes'「賞与」), and the keyword leg still reads that word on the
package document.

**The package side is not dropped altogether because of sites without abstracts.** Half the
resources here (245 of 481) have under 30 characters of name and description and stand on their
abstract. Abstracts (ADR-053) are optional per site; where they are absent, title and tags are most
of what a resource's vector has —「事項別明細　歳出」alone reaches neither the budget statement nor
Tokyo. Dropping everything only looks best above because 436 of 481 resources here carry an
abstract, and keeping title and tags costs nothing fused.

**Package side first.** The same fields in the other order dropped word P@1 from 67% to 50% and
fused word from 69 to 66 — the embedding weighs the head of the text. The resource side placed
last still separates at 0.048, little short of the 0.061 it gets first.

> Telling the model the structure with labels (「データセット: 」,「リソース: 」) was measured
> too, and lost separation for the shared words it adds (0.034). Package and resource cannot be
> told apart inside one vector; the distinction lives in the unit — one vector per resource — and
> in the budget.

### 4. Aggregate to the package with `max`; do not reward count

A package scores as the **highest** similarity among its resources. This follows directly from
decision 1: `max` is what "the package appears where its hit resource is" means as a formula.

Rewarding a package for holding several close resources was measured too, and **every step of it
made things worse** (resource unit, λ=2, K=10, floor 0.25):

| Aggregation                | overall | synonym | natural | exact |    word |
| -------------------------- | ------: | ------: | ------: | ----: | ------: |
| **`max` (best only)**      | **90%** | **96%** |     92% |  100% | **72%** |
| `max` + count α=0.1        |     90% |     94% | **94%** |  100% |     69% |
| `max` + count α=0.5        |     88% |     89% |     94% |  100% |     67% |
| `sum` (count dominates)    |     85% |     83% |     88% |  100% |     69% |
| `avg` (the centroid again) |     90% |     96% |     92% |  100% |     70% |

**Finding the single closest resource outranks holding many.**

> **`max` works here because what it aggregates states a subject.** An abstract is 200–300
> characters about one resource. The same `max` over content chunks (`extractedText`) picks up a
> line of free-text commentary or a catalogue CSV's header row — a known problem on the BM25 leg,
> and evidence that **`max` is not what is wrong there; what it is taken over is.**

### 5. Fill the window with distinct packages

Taking the top 50 over resources lets one package's resources consume it, leaving **19.5
candidate packages on average** where the package unit offered up to 50. Since decision 1 is a
model about returning N packages without repetition, this is **a requirement, not a tuning knob**.

Aggregating before taking 50 raised that to 31.9 but measured slightly worse fused, so **an
allocation such as "at most M per package" is measured before it is fixed.**

### 6. Carry the matched resource into the result, ordered by both legs

Add `resourceId` to `VectorHit` and surface it in `matchedResources` (ADR-050) as an entry with
`matchSource: 'semantic'`. **The slot already exists and has held only BM25 matches.**

```
BM25 matched a name or description  → matchSource: 'metadata'
BM25 matched the content            → matchSource: 'content'
the vector matched the meaning      → matchSource: 'semantic'   ← added here
```

**Their order within a package is decided by fusing both legs with RRF.** Neither leg may decide
alone: keeping `inner_hits` order is BM25 only, putting the vector's `max` first is the vector
only. **RRF needs ranks and nothing else, so no BM25 `_score` has to be read** — `inner_hits`
already come back in score order.

No highlight is attached: a vector match usually corresponds to no word in the document, which is
what open issue 4 asked about. **Instead of lighting up a word, name the resource.**

The similarity is shown **with a label** ("(Similarity 0.41)"). Bare, the number says nothing; against
the measured distribution — 0.2% precision in the 0.25–0.30 band, 70% above 0.50 (ADR-034, "The unit of
embedding") — it tells a reader whether the table is worth opening.

### 7. Re-draw the floor; leave the fusion parameters alone

The population goes from 166 to 481 and the similarity distribution moves with it. Measured, 0.30
admits 43 resources per query, so **the floor's candidates are 0.35–0.40.** That is the kind of
change ADR-036's notch offset exists for, adjustable from the dashboard.

`RRF_K` and `VECTOR_LEG_WEIGHT` (ADR-034, "Settling the fusion parameters") need **no
re-tuning**: the leg weight's plateau overlaps between the units, and λ = 3–4 is inside the best
region for both.

## Considered and deferred: fusing at the resource level

Taken to its conclusion, decision 1 would have the package order come from **fusing resources and
then collapsing**. The difference from decision 4 is whether "a package both legs quite like"
wins (possibly on different resources) or "a resource both legs quite like" does. The latter is
more precise.

**It is still not taken now.**

- The BM25 leg would need a **ranking across resources**. Today's `has_child` returns parents, so
  this means a different query shape — querying the child documents and collapsing on packageId —
  and it moves the meaning of paging, `total` and `matchedResourcesCount`
- **Whether it is needed cannot be measured yet.** Three queries carry resource answers and they
  read recall 0% / MRR 0.00. Decision 6 moves that off zero, and **the size of that move is what
  decides this.** Building the larger change first makes the two indistinguishable

**As a target model it is right.** When decision 6's measurement calls for agreement on the same
resource, another ADR takes it.

## Consequences

- "Which table do I open" becomes answerable. The baseline is recall 0% / MRR 0.00
- The effect on package ranking is **about +1 once fused** — within noise. **Ranking is not the
  ground this decision stands on**
- Robustness to the floor improves: at 0.35 the package unit leaves 7 of 51 queries with no vector
  at all, the resource unit none
- Vector count 166 → 481 (2.9×). **Generation costs nothing more** — the abstracts already exist
  per resource (ADR-053 decision 8). Only the embedding calls grow

## Measured after implementing (2026-09-17)

`pnpm eval:search`, local (166 packages / 481 resources, every resource re-embedded per resource,
Cohere v4, the material as decision 3 finally has it: title / tags + the resource itself),
`RRF_K` = 10, `VECTOR_LEG_WEIGHT` = 2, 51 queries.

### Package ranking

| Type      | Package unit (after ADR-034's fusion tuning) | **Resource unit** |
| --------- | -------------------------------------------: | ----------------: |
| synonym   |                                          93% |           **94%** |
| natural   |                                          95% |               92% |
| exact     |                                         100% |          **100%** |
| word nDCG |                                          63% |           **66%** |
| word R@10 |                                          76% |           **89%** |
| overall   |                                          88% |           **89%** |

**As predicted, the ranking barely moves (+1).** What moves is `word` recall (76% → 89%): a
short everyday word can now clear the floor. `exact` holds at 100%, ADR-034 decision 8's
shipping condition.

### "Which table do I open?" — from a baseline of zero

| Type    | recall (kw → hy) |   MRR (kw → hy) |
| ------- | ---------------: | --------------: |
| synonym |     0% → **50%** | 0.00 → **1.00** |
| natural |     0% → **50%** | 0.00 → **0.75** |

Every one of the three queries carrying `relevantResources` now names a relevant resource. In
the live response,「新しくオープンした美容室を知りたい」returns「美容所」as
`matchSource: 'semantic'` carrying **「美容所　新規施設一覧」** — the newly-opened list, not the
closed or the transferred one.

The one remaining miss is the 令和 4 年度 side of「汚水はどうやって処理されている?」, where the
vector picks「COD・全窒素・全りん汚濁負荷量」(0.388) over the「流入水質・放流水質」(0.379)
the golden set names — a near tie, and **not a unit problem; neither is a wrong answer.**

> One fix on the harness side: a harvested resource name can end in a newline (3 of 513 active
> resources), which a hand-typed golden entry never carries. Both sides are trimmed before
> comparison.

### The floor — decision 7's prediction was wrong

| Floor (notches) | overall | synonym | natural | word nDCG | word R@10 |
| --------------- | ------: | ------: | ------: | --------: | --------: |
| **0.25 (−2)**   | **89%** |     93% |     94% |       66% |       89% |
| 0.30 (0)        |     88% |     90% |     95% |       65% |       81% |
| 0.35 (+2)       |     86% |     89% |     91% |       64% |       76% |
| 0.40 (+4)       |     79% |     84% |     68% |       64% |       76% |

Decision 7 expected the floor to move to 0.35–0.40 with the larger population. **Through the
fusion, the existing 0.25 is best.** What the vector-leg measurement showed — that the resource
unit is robust to the floor — holds (86% at 0.35, against 78% for the package unit), but **being
robust to a higher floor is not the same as being better at one.** The floor stays where it is
(ADR-036's notches remain at −2).

### A note on the environment

During the measurement the development OpenSearch (2 GB heap) sat pinned at 97%, unmoved by
`_cache/clear`, and dropped to 14% only on restart. That is what produced three runs that
exhausted the harness's retries on 503; the figures above are from runs that completed.

**This corpus barely contains the situation the change is for.** Twenty-six of the 51 golden
queries answer with a single-resource package, where the two units are identical. None answers
with ten or more. The catalogue is the same shape: 73 of 166 packages hold one resource, two hold
ten or more (max 19). ADR-053's stated target — datasets of around a hundred tables in one package
— is absent.

**The fused +1 is therefore a lower bound, not a figure for the case this is for.** What is needed:

1. A golden set including datasets that hold many resources, with `relevantResources`
2. Reproduction on another catalogue (demo)
3. The pgvector index — none today (no HNSW / IVFFlat). Fine at 481; revisit at scale

## Open Issues

1. **The window allocation's actual value** (decision 5): measure the M in "at most M per package"
2. **Other years of the same series compete**: 「車椅子」 ranks a sibling package's questionnaire
   first (0.380) against the right answer at 0.366 — a difference the centroid used to average away
3. **Everyday-word queries bunch just above the floor**: 「子どもを預けたい」 raises the right
   answer's similarity to 0.302 per resource (0.258 per package), but everything irrelevant rises
   with it and the order does not change. **The unit does not solve this** — it needs abstracts
   that spell the action in everyday words, or query-side expansion

## Related ADRs

- ADR-025: OpenSearch parent-child index (the BM25 leg already runs decision 1's model)
- ADR-034: Metadata vector search (superseded here on the unit alone; store, fusion and floor stand)
- ADR-036: Runtime system settings (the floor's notch offset)
- ADR-050: Resource sections (the `matchedResources` slot)
- ADR-053: AI-generated resource abstracts (§8 names this as another ADR's work)
