# ADR-034: Metadata Vector Search (Semantic Search / AI-Oriented Dataset Discovery)

## Status

**Proposed** — The direction (split model deployment, unifying the vector store on
pgvector, hybrid with BM25, NoOp fallback) is agreed. Final embedding model selection and
fusion parameters will be settled through golden-set evaluation.

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
   means re-embedding everything (extending the rebuild flow).
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
  vector column update). Extend the bulk re-embedding (rebuild) command.
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

## Open Issues

1. **Final model selection**: AWS = Titan v2 vs Cohere multilingual v3; on-prem = bge-m3 vs
   multilingual-e5. Settled by golden-set evaluation.
2. **Golden set creation**: build 20–50 questions in an environment with real data
   (estimated half a day to a day).
3. **Fusion parameters**: RRF's k value, BM25/vector weighting, vector-side top-k.
4. **UI treatment**: how to present the lack of highlighting for vector hits; extension of
   `matchSource`.
5. **PDF content embedding** (later phase): chunk design, scale, and cost estimation.
   Vector count grows by 2–3 orders of magnitude, so re-evaluate pgvector (adding HNSW) vs
   splitting off to OpenSearch k-NN.
6. **Related-dataset recommendation**: a "similar datasets" display reusing the same
   vectors (achievable with offline similarity computation alone; can start independently
   of search integration).
7. **Model delivery procedure for closed networks**: settle on pre-distributed volume vs
   model-bundled image, and fold it into the installation guide.

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
