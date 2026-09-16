# ADR-034: Metadata Vector Search (Semantic Search / AI-Oriented Dataset Discovery)

## Status

**Accepted** — All decisions implemented (Phase 5a). Embedding model selection and
similarity floors were settled through golden-set evaluation (see "Evaluation Results"
below, 2026-07-07).

## Context

Current search is keyword matching via BM25 (OpenSearch) / ILIKE + full-text search
(PostgreSQL) (ADR-009), which has the following limitations:

- **Vocabulary mismatch**: searching for "ごみ収集" (garbage collection) does not hit
  datasets described as "廃棄物" (waste).
- **Weak on natural-language queries**: cannot handle queries such as "子育て支援の施設はどこ?"
  (where are the childcare support facilities?).
- **Discovery by AI agents**: the MCP foundation of ADR-032 established the use case of AI
  agents exploring the catalog. Agents search for datasets in natural language, so with
  keyword matching alone the entry point (discovery) of the "explore → schema → query" loop
  becomes a bottleneck.

We therefore introduce hybrid search that embeds metadata (the package's title / notes /
tags concatenated with the name / description of its resources) into vectors and fuses them
with BM25. Resource metadata is included because the BM25 side already searches the
kukan-resources index (ADR-025); narrowing only the vector side would create an asymmetry
where datasets findable only via resource names are invisible to semantic search. The primary goal is **improved search and discovery**,
with **dataset discovery for AI/MCP agents** as a first-class target.

Scope expands in stages:

- **v1: package-level vectors only** (1 package = 1 vector, thousands to tens of thousands
  of items. The vector count is small, so exact search remains viable.) Resource metadata is
  folded into the package text; no independent per-resource vectors are created.
- **Later-phase candidate: extracted resource content** (equivalent to kukan-contents),
  **limited to text formats (PDF, etc.)**. Tabular data such as CSV/TSV benefits little
  from embedding-based semantic search; that is the domain of ADR-032's schema + query path.

### Background: embedding models and generative AI models are independent

Embedding vectors are **specific to each embedding model** and are not interchangeable
across models (dimensions and the geometry of the vector space differ; no shared standard
vector format exists). On the other hand, the **generative AI (Claude/GPT/local LLM, etc.)
consuming the search results does not need to match the embedding model** — the generative
AI reads the text that search returns and never touches the vectors. Therefore:

- Queries and documents must be embedded with the **same embedding model** (consistency
  only needs to hold within each environment).
- Changing the embedding model = **re-embedding everything + rebuilding the index**.
- Which generative AI calls MCP has no bearing on embedding model selection.

## Options Considered

### 1. Embedding model deployment

#### Option U: Unified self-hosting

Self-host an open-weight model (e.g. bge-m3) in both environments: Ollama on-premises, and
an Ollama / HuggingFace TEI container on ECS Fargate in AWS. Embedding models are small
(bge-m3 is 568M parameters) and practical with CPU inference, so this is technically viable.

- Pros: identical search quality in all environments, evaluation covers one model,
  no model-deprecation risk.
- Cons: **adds one always-on inference service (a Fargate task) to AWS**.

#### Option D: Per-environment split (adopted)

| Environment       | Embedding backend                                            | Notes                                           |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| AWS               | Bedrock (Titan Embeddings v2 / Cohere embed-multilingual v3) | Pay-per-use, zero added infrastructure          |
| On-prem / closed  | Ollama (bge-m3 primary / multilingual-e5 secondary)          | Fully local, no external transmission           |
| No-AI environment | NoOp → **vector search disabled, degrade to BM25 only**      | Search itself keeps working in all environments |

- Pros: **no new infrastructure (Fargate task)**. Realizable as an extension of the existing
  AIAdapter implementations (bedrock / ollama / noop).
- Cons: vectors are not compatible across environments, and evaluation covers two models.
  - However, **index portability is not needed in practice** (each deployment holds its
    index in its own search backend; vectors are never carried across environments).
  - Evaluation cost is kept low by **scripting** the golden-set evaluation so the second
    and subsequent models are cheap to assess.

> **Decision**: with "do not add a new Fargate task" as a constraint, **adopt Option D
> (split)**. Option U is kept as the migration target if AWS-side accuracy or cost
> requirements change in the future.

#### Model selection criteria (in priority order)

1. **Hard filters**: runs in the deployment environment (available on Bedrock / runnable
   via Ollama), Japanese retrieval quality (compare JMTEB Retrieval scores; look at
   retrieval tasks, not the average), commercially usable license (for local models;
   the e5 family and bge-m3 are MIT).
2. **Comparison criteria**: input token limit (8192 support is advantageous with PDF
   content in mind), dimensionality (directly affects index size and memory; ≤1024 is
   safe; Matryoshka support leaves room to shrink), cost (query-side cost accrues per
   search), query embedding latency, asymmetric-search prefixes (e5's `query:`/`passage:`
   etc.), continuity of availability (deprecation = re-embedding everything).
3. **The final call is made by golden-set evaluation** (below); benchmarks are used only
   for shortlisting.

### 2. Vector storage

#### Option B: Per-backend (each search backend holds its own vectors)

| Backend    | Approach          | Notes                                                                                   |
| ---------- | ----------------- | --------------------------------------------------------------------------------------- |
| OpenSearch | k-NN (knn_vector) | HNSW consumes off-heap memory. Take care on small instances.                            |
| PostgreSQL | pgvector          | Supported on Aurora Serverless v2. On-prem switches to a pgvector-bundled Docker image. |

- Pros: search and fusion stay inside each backend (OpenSearch can use its search pipeline).
- Cons: two vector implementations are required. OpenSearch k-NN (HNSW) consumes off-heap
  memory, which sits badly with our past lesson of heap exhaustion on a small instance.
  Vectors also need re-ingestion whenever the OpenSearch index is rebuilt.

#### Option P: Unified on pgvector (adopted)

Store vectors in PostgreSQL (pgvector) in every environment, and keep OpenSearch dedicated
to BM25 + facets. Vectors live as a column on the package table managed by the Drizzle
schema, with the model name, dimensionality, and content hash on the same row.

- Pros:
  - **The vector search implementation is shared across all environments.** Environment
    differences are confined to the keyword side (unchanged), roughly halving
    implementation and testing.
  - No change to OpenSearch memory sizing (avoids k-NN off-heap consumption).
  - Embedding updates are **transactional in the same DB as the metadata** (no dual write
    to OpenSearch). Vectors survive OpenSearch index rebuilds.
  - drizzle-orm supports the pgvector `vector` type, so migrations stay on the existing flow.
- Cons / trade-offs:
  - In the AWS configuration, hybrid fusion crosses stores, so **RRF is implemented in the
    service layer** (OpenSearch's search pipeline is not used). The PG-fallback environment
    needs manual RRF anyway, so this is the flip side of having fusion logic shared across
    environments.
  - Each search issues two queries (OpenSearch + PG), run in parallel; the dominant term is
    query-embedding latency, so the perceived impact is minor.
  - Visibility filters are also needed on the vector side (reusing the PG adapter's
    existing `SearchFilters` WHERE implementation).
  - Search load lands on the primary DB. Negligible at v1 metadata scale, but whether the
    later-phase PDF content embedding (vector count grows by 2–3 orders of magnitude and
    needs HNSW) also goes into PG is re-evaluated at that point.

> **Decision**: given headroom on the PG/Aurora side and the large benefit of a shared
> implementation, **adopt Option P (unified on pgvector)**. Since the v1 target (package
> metadata) has a small vector count, no HNSW index is created; operate with filter +
> full-scan distance computation (exact search).

### 3. When embeddings are generated

- **Document side**: keep the synchronous BM25 index update on metadata CUD (in API routes)
  as is, and make **embedding generation an asynchronous job via QueueAdapter** (eventual
  consistency). Embedding involves external API calls with latency and failure modes, so it
  must not sit on the request path. Store a **content hash of the source text** to skip
  re-embedding unchanged documents.
- **Query side**: every search request needs an embedding (+100–300 ms). **Cache query
  embeddings with lru-cache** (reusing the ADR-004 utility as is).

### 4. Fusion with BM25 (hybrid search)

- Retrieve top-k from BM25 (OpenSearch / PG full-text search) and top-k from vectors
  (pgvector), then **fuse with RRF (Reciprocal Rank Fusion) in the service layer**. Because
  Option P crosses stores, OpenSearch's search pipeline is not used and the fusion logic is
  shared across all environments.
- A known failure pattern is that **vectors can degrade precision for exact-match queries**
  (dataset names, organization names typed verbatim). Validate fusion weights with the
  golden set so degradation is detectable.
- Since vector search only returns top-k, sort out at implementation time the semantics of
  `total`, pagination, facet aggregation (stays on the OpenSearch/BM25 side), and the lack
  of highlighting (vector hits carry no `<mark>`).

### 5. Evaluation: the golden set

Manually build pairs of queries and their correct datasets (20–50 questions) and measure
Recall@10 / nDCG@10 with a script. **Always mix query types: synonym, natural-language,
and exact-match** (exact-match is for regression detection). It serves three purposes:
model comparison, fusion weight tuning, and regression testing. Because of the split
deployment (Option D), run the same set against both the AWS and on-prem models.

## Decision

1. **Purpose**: semantic search over metadata and dataset discovery for AI/MCP agents.
   v1 targets package-level vectors only (title / notes / tags concatenated with the
   name / description of the package's resources). Resource CUD also re-embeds the parent
   package.
2. **Deployment is Option D (per-environment split)**: AWS = Bedrock, on-prem = Ollama,
   NoOp environments = vector search disabled (degrade to BM25 only). No new Fargate tasks.
3. **The vector store is Option P (unified on pgvector)**: stored in PostgreSQL in every
   environment; OpenSearch stays dedicated to BM25 + facets. Hybrid fusion is RRF in the
   service layer, shared across environments.
4. **Design vector search as an optional feature.** Give SearchAdapter a capability flag so
   that in environments without embedding, search still works fully on BM25 alone.
5. **Queries and documents use the same embedding model.** Record the **model name +
   dimensionality alongside the vectors** so mismatches are detectable. Changing models
   means re-embedding everything (a dedicated job, `embed-all-packages`, behind
   `POST /admin/reindex-embeddings` — independent of the search-index rebuild, since
   embedding does not use OpenSearch).
6. **Document-side embedding is asynchronous** (via QueueAdapter, eventually consistent);
   **query-side embeddings are cached with lru-cache**.
7. **Extend AIAdapter's `embed()`**: batch embedding, query/document distinction (absorbing
   model-specific prefixes), and exposure of model name and dimensionality. This stays
   within the existing four adapters and does not conflict with ADR-005.
8. **Run golden-set evaluation before launch** and decide model selection and fusion
   weights numerically. No regression on exact-match queries is a shipping condition.
9. **Embedding of resource content (text formats such as PDF) is a later phase** and out of
   scope for this ADR. Tabular data (CSV/TSV) is not embedded (that is ADR-032 territory).

## Consequences

- **packages/adapters/ai**: extend `embed()` (batch, usage distinction, model metadata
  exposure). Add embedding model configuration to the bedrock / ollama implementations;
  noop explicitly signals "embedding unavailable".
- **packages/adapters/search**: implement vector search only on the PostgreSQL side
  (pgvector), reusing the existing `SearchFilters` WHERE implementation for visibility
  filtering. The OpenSearch implementation stays dedicated to BM25 + facets with minimal
  change. Hybrid fusion (RRF) sits in the service layer above the adapters, shared across
  environments. Expose a capability flag (vector search availability).
- **DB / infrastructure**: add a vector column plus model name, dimensionality, and content
  hash to the package table (Drizzle migration). Switch the on-prem PostgreSQL image to the
  pgvector-bundled one (`pgvector/pgvector:pg16`) in compose.yml. This moves the base from
  alpine to Debian and changes the collation implementation, so existing installations need
  pg_dump/restore or REINDEX (dev environments can simply recreate the volume). Aurora only
  needs the extension enabled (`CREATE EXTENSION vector`). No change to OpenSearch sizing.
- **worker / queue**: add an embedding-generation job (metadata CUD → enqueue → embed →
  vector column update). A dedicated bulk re-embedding job. Enqueues are held to one per
  package per minute, since a bulk import would otherwise queue one per resource.
- **compose.yml (Ollama)**: add Ollama as an optional service (profiles) with the **same
  configuration for development and on-prem** (dev/prod parity; embeddings run fine on CPU
  inference, so no GPU setup is needed). Closed networks cannot use `ollama pull`, so models
  require **offline delivery** (pre-distributing the model volume, or distributing an image
  bundling the model).
- **Security / data sovereignty**: in AWS environments metadata is sent to Bedrock (stays
  within AWS). In closed networks, Ollama keeps everything local with no external
  transmission.
- **Operations**: the embedding-model change procedure (re-embedding) and golden-set
  maintenance become new operational items.

## Evaluation Results (2026-07-07)

Recall@10 / nDCG@10 measured with per-deployment golden sets (39 queries each = 13
exact / synonym / natural, plus 3 no-answer queries as a noise probe). Numbers read
"keyword-only → hybrid". Golden sets themselves are deployment-specific and are not
committed (see `golden-queries.example.yaml`).

### On-prem (local real data, 166 packages, bge-m3 @ 0.45)

| type             | R@10                        | nDCG          |
| ---------------- | --------------------------- | ------------- |
| exact            | 100% → 100% (no regression) | 100% → 100%   |
| synonym          | 0% → 96%                    | 0% → 79%      |
| natural          | 15% → 90%                   | 15% → 66%     |
| **overall nDCG** |                             | **38% → 82%** |

### AWS (demo, nationwide municipal data, 181 packages — model shootout)

|                                  | **Cohere Embed v4 @ 0.3 (recommended)**                   | Titan v2 @ 0.15 (default) |
| -------------------------------- | --------------------------------------------------------- | ------------------------- |
| synonym R@10                     | **74%**                                                   | 72%                       |
| natural R@10                     | **71%**                                                   | 66%                       |
| exact R@10                       | 85% (no regression)                                       | 85%                       |
| overall nDCG                     | **75%**                                                   | 70%                       |
| Pseudo-hits on no-answer queries | 0–1                                                       | 1                         |
| Setup friction                   | Marketplace subscription (one admin invoke + propagation) | none (auto-enabled)       |
| Price / 1M tokens                | $0.10                                                     | $0.02                     |

- **Similarity floors are not transferable between models** — Japanese pairs distribute
  very differently (bge-m3 relevant pairs at 0.47–0.62 vs Titan v2 at 0.05–0.25 and
  Cohere v4 at 0.15–0.4). Sweeps picked the point keeping 97–99% of the recall ceiling
  while silencing no-answer queries: bge-m3 = 0.45, Titan v2 = 0.15, Cohere v4 = 0.3.
  The measured floors live inside the AI adapters
  (`EmbeddingInfo.recommendedMinSimilarity`), overridable via env.
- **Conclusion**: on-prem = bge-m3 (confirmed). AWS default = Titan v2 (zero friction);
  opt in to Cohere Embed v4 when quality matters (+5–12pt, especially question-form
  queries). Re-measure with the golden set whenever the model changes.
- Cohere v3 and multilingual-e5 were disqualified before the shootout by their 512-token
  input limit (the concatenated text needs ~8K); Cohere v4 (128K) removed that constraint.

### Re-measured (2026-09-12)

The same golden sets (39 questions each), measured again. **Local now embeds with Titan v2
(1024 dims) rather than bge-m3** (`AI_TYPE=bedrock`), yet the overall nDCG is unchanged.

| Environment                           |         2026-07-07 |               2026-09-12 |
| ------------------------------------- | -----------------: | -----------------------: |
| Local (166 → **168** packages)        | 38% → 82% (bge-m3) | **38% → 82%** (Titan v2) |
| demo (181 → **184** packages, Cohere) |                75% |                  **87%** |

Per type (2026-09-12, keyword-only → hybrid):

| type    |  Local R@10 |  Local nDCG |  demo R@10 | demo nDCG |
| ------- | ----------: | ----------: | ---------: | --------: |
| synonym |    0% → 92% |    0% → 75% |   0% → 92% |  0% → 82% |
| natural |   15% → 95% |   15% → 72% |   0% → 81% |  0% → 80% |
| exact   | 100% → 100% | 100% → 100% | 88% → 100% | 88% → 98% |

**Every relevant dataset name in both golden sets still resolves** (local 56/56, demo 41/41),
and there is no exact-match regression.

> The harness only writes to stdout. **This section is the record of record.** Run it as
> `pnpm eval:search --base <URL> --file <YAML>` — no `--` separator, which `parseArgs` rejects
> as a positional.

### Re-measured (2026-09-16) — prefix removal and "データ" as a stop word

Local (167 packages / 482 resources, Cohere v4, `vector-similarity-notches` = −2, golden set of
51 = synonym 13 / natural 13 / exact 13 / word 12). **Measured on a corpus whose abstracts
(ADR-053) had been regenerated the night before — 324 of them** — so it is not comparable with
the earlier figures (caveat 2 below). The two indexes compared were both `_reindex`ed from the
same source (caveat 1).

| Index                                                          | word R@10 | word nDCG (kw → hy) | Other types                     |
| -------------------------------------------------------------- | --------: | ------------------: | ------------------------------- |
| Without prefix removal (`ja_prefix` dropped, then `_reindex`)  |       76% |           57% → 63% | unchanged                       |
| With prefix removal (as shipped)                               |       76% |           57% → 63% | synonym: one query −7 (reorder) |
| As shipped + "データ" as a query-side stop word (keyword only) |       76% |                 57% | 0 queries move                  |

Prefix removal (`kuromoji_part_of_speech` dropping `接頭詞-名詞接続` on both the index and the
query side) has **no measurable effect** on the golden set: one query +1 on the keyword leg,
one query −7 on hybrid, both a reshuffle at ranks 7–10. The analysis does what it is meant to
(お年寄り → 年寄り, ご案内 → 案内, 全世帯 → 世帯; お茶 and お客 untouched), so its value is on
the highlighter and on consistency between the two sides. **The "word nDCG 72% → 81%" first
attributed to this change was wrong** — 79% is the two-notch floor change made at the same time
(ADR-036), and the rest is the variance in caveat 1.

Stopping "データ" moved no query. The catalogue CSVs that stay near the top for
「子育てに関するデータ」 are the content leg's `score_mode: 'max'`, not a stop-word problem.

**Caveats on the instrument:**

1. **The same index content measured word nDCG 54% and 57%.** An index grown by incremental
   writes and one fresh from `_reindex` differ in BM25 statistics (deleted documents count until
   a merge), and near-ties reorder. With 12 word queries, anything under 3 points is noise.
   Align the indexes being compared with `_reindex` (or `_forcemerge`) first.
2. **Regenerating the abstracts changes the corpus.** For most word queries the everyday
   vocabulary in an abstract is the only lexical bridge; regenerate it with different wording
   (「高齢者（お年寄り）」 → 「介護サービス事業所」) and the query loses the keyword leg. The
   previous day's word R@10 of 96% → 76% is this, with the relevant packages themselves intact.
   That the vector leg does not catch it — a package-level vector that never clears the floor —
   is a reason to measure resource-level vectors (ADR-053 §8).

### The unit of embedding (2026-09-16, measured offline)

**One vector per package, or one per resource** — compared offline, before writing any code.
Local (166 packages / 481 resources, Cohere embed-v4, 51 golden queries). The package vectors
already in the database serve as the baseline and only the candidate side was rebuilt, so
**the model and the corpus are identical**. No code was written.

#### Vector leg only, floor 0.30 (resource hits aggregated to packages with max)

| Unit and material                   | word R@10 | word nDCG | overall nDCG | Queries where nothing clears the floor |
| ----------------------------------- | --------: | --------: | -----------: | -------------------------------------: |
| **Package (as shipped)**            |       65% |       51% |          86% |                                      1 |
| Package − notes                     |       76% |       56% |          88% |                                      0 |
| Resource + title/tags/notes/section |       81% |       64% |          90% |                                      1 |
| Resource alone                      |       89% |       69% |          90% |                                      0 |
| **Resource + title/tags**           |       89% |   **70%** |      **92%** |                                      0 |

**Two contributions, and they rank: the unit is worth +13, dropping `notes` +5 to +6.**
`synonym` / `natural` / `exact` do not move under any of them (96–100%). Only short everyday
words move, which is what ADR-053 decision 8 predicted — a centroid of heterogeneous resources
resembles no subject.

**The gap widens as the floor rises.** At 0.35 the package unit leaves 7 of 51 queries with no
vector at all, and 11 at 0.40; the resource unit leaves none (4 at 0.40). **A short query
failing to clear the floor was the unit, not the model.**

> `notes` averages 57 characters per resource (16% of the text), so it is not diluting by
> length. A municipal dataset description is largely boilerplate —「〜に関するデータです」—
> and **draws every vector together with words that separate no subject**. Title and tags do no
> harm because they do the opposite: they name the subject in a few words.

#### Looking at resources without aggregating

The aggregation exists because the golden set's ground truth is a package name, and **it puts
the package back as the unit the moment it runs**. The floor, and what to display, belong to
the resource-side distribution.

Across 51 queries × 481 resources = 24,531 pairs: median 0.198, p90 0.294, p99 0.433, max 0.801.

| Floor | Pairs kept | Per query |
| ----: | ---------- | --------: |
|  0.30 | 8.98%      |      43.2 |
|  0.35 | 3.83%      |      18.4 |
|  0.40 | 1.64%      |       7.9 |

**0.30 is too loose here.** Forty-three resources per query clear it, so noise arrives before
the fusion does. The population goes from 166 to 481, so the package unit's operating point does
not carry over. Candidates are 0.35–0.40.

Precision, counting a resource as relevant when its package is a golden answer:

| Type    |  P@1 | P@5 |  MRR |
| ------- | ---: | --: | ---: |
| synonym | 100% | 49% | 1.00 |
| natural |  92% | 46% | 0.95 |
| exact   | 100% | 49% | 1.00 |
| word    |  58% | 40% | 0.69 |

Outside `word`, **the top resource is almost always one of the right package's** (P@5 falls only
because there are 1–3 relevant packages). **Which resource matched is worth showing** — it fits
ADR-050's `matchedResources` unchanged.

What it finds, and what it does not:

- **The unit did the work**:「積立金」lands on the sheet 「公金管理実績 P1 内訳 基金」(0.407),
  which the package unit had averaged across 19 sheets.「外国人」returns four distinct resources
  of the right package in its top four
- **The noise is other years of the same series**.「車椅子」ranks a questionnaire from a sibling
  package first (0.380) against the right answer at 0.366. Aggregation absorbs some of this;
  showing resources would not
- **Not a unit problem**:「小さい子ども」returns five school-statistics resources and never the
  child-care registry — pre-school and primary are not separated (model granularity).
  「お年寄り」suffers from its answer's abstract having been rewritten from 「高齢者（お年寄り）」
  to「介護サービス事業所」, which is vocabulary

#### Through the fusion, almost none of the ranking gain survives

**The figures above are the vector leg alone, which is not the order anyone sees.** So only that
leg was swapped: BM25 comes from the live API and the fusion runs the shipped formula
(`FUSION_WINDOW` 50, `RRF_K` 60, vote `clamp((sim − floor) / 0.2)`, floor at the 0.25 in use).

| Type         | Keyword only | Package unit | Resource unit |
| ------------ | -----------: | -----------: | ------------: |
| synonym nDCG |           0% |          79% |           80% |
| natural nDCG |          26% |          81% |           79% |
| exact nDCG   |         100% |         100% |          100% |
| word nDCG    |          57% |          63% |           65% |
| word R@10    |          76% |          85% |           89% |
| **overall**  |          45% |      **81%** |       **81%** |

**The +19 on `word` nDCG becomes +2 once fused.** Overall does not move; twelve of 51 queries
change and they cancel, six better and six worse. The reason is plain: **BM25 has already found
them.** Recall is at the ceiling for synonym / natural / exact, and RRF passes almost none of the
vector leg's internal reordering through to the result.

Two things survive: **robustness to the floor** (at 0.35, package 78% against resource 80%, with
7 queries versus 0 left holding no vector at all) and **`word` recall** (76% → 89%).

One new constraint appears. Taking the kNN window (50) over resources lets one package's
resources consume it, so **the candidate list offers 19.5 packages on average** where the package
unit offers up to 50. Aggregating before taking 50 raises that to 31.9 and measured slightly
worse fused. **How the window is allocated is an implementation question.**

#### What moved the numbers was neither the unit nor the formula, but the leg weight

Sweeping the fusion side (floor 0.25, 51 queries). `rrf` is what ships; `sim` votes by similarity
rather than rank; `simnorm` normalises the similarity within the query.

| Configuration                           | overall | synonym | natural | exact | word |
| --------------------------------------- | ------: | ------: | ------: | ----: | ---: |
| **Shipped** (`rrf`, K=60, λ=1, package) | **81%** |     79% |     81% |  100% |  63% |
| `simnorm`, K=10, **λ=2**, package       | **91%** |     98% |     95% |  100% |  70% |
| `simnorm`, K=10, λ=3, resource          | **92%** |     99% |     95% |  100% |  71% |

**Overall goes 81% → 91% with no change to any embedding.** The gain is in `synonym` (79 → 98)
and `natural` (81 → 95) — **the vector leg was finding the right answer and RRF was letting BM25
bury it.** `exact` holds at 100% throughout, so decision 8's shipping condition is met.

`RRF_K` = 60 against a 50-long list puts rank 1 and rank 50 within 1.8× of each other, which
leaves RRF asking little beyond "is it in both lists" — and on a query keyword search cannot
answer at all (synonym scores 0% on its own) the vector leg cannot lift its answer to the top.
This is exactly what open issue 3 flagged as "leg weighting is left at the default".

#### The two units' plateaus overlap, so the tuning is done once

Floor × λ for both units (`simnorm`, K=10, overall nDCG).

| Floor ＼ λ             |   1 |      2 |      3 |      4 |      6 |
| ---------------------- | --: | -----: | -----: | -----: | -----: |
| **Package unit** 0.25  |  82 | **91** | **91** | **91** | **91** |
| 0.30                   |  81 |     89 |     89 |     89 |     89 |
| 0.35                   |  78 |     85 |     85 |     85 |     85 |
| **Resource unit** 0.25 |  82 |     90 | **92** | **92** | **92** |
| 0.30                   |  82 |     91 |     91 | **92** | **92** |
| 0.35                   |  82 | **91** | **91** | **91** | **91** |
| 0.40                   |  79 |     87 |     87 |     87 |     87 |

**λ and K need no re-tuning when the unit changes.** Both plateau from λ ≥ 2–3, and λ = 3–4 sits
**inside both plateaus at once** (package 91, resource 92 — each unit's own best). The only step
is λ 1 → 2.

**The floor does need re-drawing.** The package unit peaks at 0.25 and falls monotonically; the
resource unit is flat from 0.25 to 0.35 and only drops at 0.40, because the population grows from
166 to 481 and the distribution moves with it. That is the kind of change ADR-036's notch offset
exists for, and it is adjustable from the dashboard.

> **Take the plateau, not the peak.** Thirty-odd configurations against 51 queries can overfit,
> and a plateau value both avoids that and survives a change of unit — **two reasons pointing at
> one conclusion.** Choosing λ=2 by looking at the package unit alone gives 90 on the resource
> unit where λ=3 gives 92.

#### Ranking is not what this change is mainly for

The golden set's ground truth is a package name, so **every figure above evaluates package
ranking**. What per-resource vectors actually answer is a different question, and there is no
instrument for it here.

Whether the unit separates resources _within_ a package is measurable. Across relevant packages
holding three or more, the best resource's similarity stands **0.038–0.047** above that package's
mean (37 query-package pairs). In practice:

| Query                              | Resource chosen          | Resource ranked last     |
| ---------------------------------- | ------------------------ | ------------------------ |
| 新しくオープンした美容室を知りたい | **新規**施設一覧 0.553   | **廃止**施設一覧 0.398   |
| 汚水はどうやって処理されている?    | 流入水質・放流水質 0.388 | ダイオキシン類測定 0.348 |

**Picking the "newly opened" list over the "closed" one is not something a centroid can do** —
the package's five resources are averaged into one vector.

This bears directly on open issue 4 (vector hits cannot be highlighted; extending `matchSource`).
Today a package matched only semantically comes back with an empty `matchedOn` and **nothing
explains why it is there**. ADR-050's `matchedResources` already holds the slot for "which
resource matched", and only BM25 hits reach it. Per-resource vectors fill that gap.

#### What was not measured

**This corpus barely contains the situation the change is for.** Grouped by how many resources
the relevant packages hold:

| Resources in the relevant package | Queries | Package unit | Resource unit |        Δ |
| --------------------------------- | ------: | -----------: | ------------: | -------: |
| 1                                 |      26 |        94.5% |         94.4% |     ±0.0 |
| 2–4                               |       5 |        88.9% |         85.8% |     −3.0 |
| 5–9                               |      20 |        87.6% |         89.4% | **+1.8** |
| 10 or more                        |       0 |            — |             — |        — |

**Twenty-six of 51 queries answer with a single-resource package, where the two units are
identical.** None answers with ten or more. The catalogue is the same shape: 73 of 166 packages
hold one resource and two hold ten or more (max 19). ADR-053's stated target — datasets of around
a hundred tables in one package — is absent. **The fused +1 is a lower bound, not a figure for the
case this is for.**

Also unmeasured: a golden set with per-resource answers (the instrument the purpose above needs),
the pgvector index (166 → 481 vectors, currently unindexed), and reproduction on another catalogue.

> These numbers come from **a simulator that copies the shipped formula**, not from the code
> itself. Re-measure in the code before adopting anything.

## Open Issues

1. ~~**Final model selection**~~ → **Resolved** (see "Evaluation Results": on-prem =
   bge-m3; AWS = Titan v2 default / Cohere Embed v4 recommended opt-in).
2. ~~**Golden set creation**~~ → **Resolved** (39 questions local + 39 on demo;
   established as a per-deployment, non-committed practice).
3. **Fusion parameters**: similarity floors resolved (see Evaluation Results). RRF's k
   (=60) and leg weighting remain at defaults. **Measured on 2026-09-16, this is where the
   headroom is** — raising the leg weight alone takes overall from 81% to 91%, with no change
   to any embedding or analyzer ("The unit of embedding"). Thirty-odd configurations against
   51 queries can overfit, so **take a plateau value rather than the peak**, confirm it
   reproduces on another catalogue, and re-measure in the code before adopting it.
4. **UI treatment**: how to present the lack of highlighting for vector hits; extension of
   `matchSource`. **Per-resource vectors (same section) bear on this directly** — a
   semantically matched resource can be named, which is what ADR-050's `matchedResources`
   already displays. Today `matchedOn` comes back empty and nothing explains the result.
5. **PDF content embedding** (later phase): chunk design, scale, and cost estimation.
   Vector count grows by 2–3 orders of magnitude, so re-evaluate pgvector (adding HNSW) vs
   splitting off to OpenSearch k-NN.
6. **Related-dataset recommendation**: a "similar datasets" display reusing the same
   vectors (achievable with offline similarity computation alone; can start independently
   of search integration).
7. **Model delivery procedure for closed networks**: settle on pre-distributed volume vs
   model-bundled image, and fold it into the installation guide.
8. **Hybrid search shutdown from the admin UI**: an operational switch letting sysadmins
   disable vector search across the board on quality degradation or cost anomalies.
   Provider outages are out of scope — they auto-degrade via query-embedding timeout +
   BM25 fallback (an env-based kill switch was considered and rejected).

## Related ADRs

- ADR-001: Drizzle ORM (schema management for the vector column)
- ADR-004: lru-cache (used for query embedding caching)
- ADR-005: Only four adapters (this ADR stays within extensions of the existing AIAdapter /
  SearchAdapter and adds no new adapter)
- ADR-009: Japanese full-text search and fallback (the BM25-side premise; the degrade
  philosophy is inherited)
- ADR-013: Separation of search and DB filtering (maintained under hybrid search)
- ADR-021: Resource content full-text search (the foundation for later-phase PDF embedding)
- ADR-025: OpenSearch parent-child integration (no OpenSearch mapping change needed thanks
  to pgvector unification)
- ADR-032: MCP data query foundation (this ADR strengthens the discovery entry point for AI
  agents)
