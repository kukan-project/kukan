# ADR-054: Embed per resource — answering "which table do I open?"

## Status

**Proposed** — measured offline already (ADR-034, "The unit of embedding" and "Settling the
fusion parameters"). **This supersedes only the part of ADR-034 that fixes the unit of
embedding.** The store (pgvector alone), the fusion (RRF in the service layer), how the
similarity floor resolves, and the golden-set practice all stand as written there.

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

### 3. What is embedded is the package's metadata plus the resource itself

```
package title / tags / notes
resource section / name / description / abstract
```

**Including `notes` follows from decision 2.** With the package vector gone, leaving it out would
mean `notes` **exists in no vector at all**. It stays a first-class signal on the keyword leg, as
the parent document's field, but a paraphrase that shares no word with it would have no path.

Measured through the fusion, the material barely matters (resource unit, λ=2 / K=10, floor 0.25):

| Material              | overall | synonym | natural | exact |    word |
| --------------------- | ------: | ------: | ------: | ----: | ------: |
| title + tags          |     90% | **96%** |     92% |  100% | **72%** |
| **+ notes + section** |     90% |     94% | **93%** |  100% |     69% |
| resource alone        |     90% |     94% |     91% |  100% | **72%** |

Adding `notes` costs 3 points of `word` and gains 1 of `natural` — **0.4 of a query either way,
across twelve and thirteen.** On the vector leg alone the same choice looked like 70% → 64%;
**the fusion absorbs it.**

**Where the difference is noise, take the side that loses no information.**

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

## What the measurement does not cover

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
