> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase5-vector-search.md`](../jp/phase5-vector-search.md).

# Phase 5a: Metadata Vector Search (Semantic Search) — Implementation Spec

> **This is a record of a completed phase.** Later ADRs have changed parts of the implementation,
> so for the current shape see the phase list in `CLAUDE.md` and `docs/pipeline.md`. The file paths
> and step names below are the ones in use at the time.

> **Goal**: Embed package metadata as vectors and run hybrid search with BM25 in both the web
> search UI and MCP/API. In environments without AI (NoOp), degrade automatically to BM25 only.
> ADR-034 is authoritative for the design decisions.

## 1. Prerequisites

- Phases 1–3 complete (CRUD + search + pipeline + Worker + Queue)
- Phase 4 (AWS deploy & CDK) is in progress but has no implementation dependency on this phase,
  so the two **can proceed in parallel**
- ADR-034 agreed: per-environment separation (AWS=Bedrock / on-premises=Ollama / NoOp=degrade),
  the vector store consolidated on pgvector, fusion by RRF in the service layer
- `AIAdapter.embed()` is interface definition only (both bedrock and ollama are **stubs**,
  `packages/adapters/ai/src/`) → implemented in this phase
- BM25 index updates for metadata run synchronously in the API routes
  (`services/search-index.ts`) → unchanged

### Settled points (results of the grilling)

| Question         | Decision                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Order of work    | Spec first (this document). No dependency on Phase 4, so implementation starts in parallel     |
| v1 exposure      | Both the web search UI and MCP/API                                                             |
| Model choice     | Implement first with provisional models. Golden-set evaluation comes after real data is loaded |
| Default behavior | Hybrid is **ON by default**. The query parameter `semantic=false` falls back to BM25 only      |

### Provisional models

| Environment       | Model                       | Dims | Notes                                        |
| ----------------- | --------------------------- | :--: | -------------------------------------------- |
| AWS               | Bedrock Titan Embeddings v2 | 1024 | Matryoshka-capable (room to shrink to 512)   |
| Dev / on-premises | Ollama bge-m3               | 1024 | MIT, 8192 tokens, practical on CPU inference |

Swapping models after evaluation is handled by "re-embedding everything (rebuild)"
(ADR-034 decision 5).

## 2. Technology Stack (additions for Phase 5a)

| Category         | Technology                | Notes                                                                      |
| ---------------- | ------------------------- | -------------------------------------------------------------------------- |
| Vector extension | pgvector                  | Aurora: `CREATE EXTENSION vector` / local: swap the image                  |
| PostgreSQL image | `pgvector/pgvector:pg16`  | alpine → Debian change. Existing environments need dump/restore or REINDEX |
| Local embeddings | `ollama/ollama`           | Started in the default compose stack. Models persisted on a volume         |
| ORM type         | drizzle-orm `vector` type | Column without a dimension (no DDL needed when the model changes)          |

## 3. Architecture Overview

### Write flow (document side, asynchronous)

```
[API] package CUD
  ├─ BM25 index update (existing, still synchronous)
  └─ enqueue embed job (QueueAdapter, only when the AIAdapter can embed)
        │
[Worker] embed-package job
  1. fetch package → build the text to embed (title + notes + tags + resource name/description)
  2. compare the content hash → skip when unchanged
  3. AIAdapter.embed(text, { type: 'document' })
  4. UPDATE package SET embedding, embedding_model, embedding_hash
```

### Search flow (query side, synchronous)

```
[API] GET /api/v1/search?q=...&semantic=(true)
  ├─ run in parallel
  │   ├─ BM25: SearchAdapter.search() (existing; highlights / matchedResources come from here)
  │   └─ vector: embed(q, {type:'query'}) (lru-cache) → pgvector top-k (visibility filter applied)
  ├─ RRF fusion in the service layer (k=60, `limit` items from the top)
  └─ response (vector-derived hits carry matchSource: 'semantic')
```

- With `semantic=false`, in a NoOp environment, or when query embedding fails, BM25 only
  (exactly matching the existing behavior)
- Pagination in hybrid mode is applied to the RRF result list. `total` keeps the BM25 value,
  and we do not demand strictness about the extra vector hits (the UI wording is sorted out
  during implementation)

## 4. Step 1: Extending and Implementing the AIAdapter

### 4.1 Interface extension (`packages/adapters/ai/src/adapter.ts`)

```typescript
export interface EmbedOptions {
  /** 'query' | 'document' — e5-style prefixes and the like are absorbed inside the adapter */
  type?: 'query' | 'document'
}

export interface EmbeddingInfo {
  model: string // e.g. 'amazon.titan-embed-text-v2:0', 'bge-m3'
  dimensions: number // e.g. 1024
}

/** Vector-space key "model name@dimensions" — the unit of comparison for storage
 *  (embedding_model), search and caching. Matryoshka models can change dimensions under the
 *  same name, so the dimension count is part of the key */
export function embeddingKey(info: EmbeddingInfo): string // → 'bge-m3@1024'

export interface AIAdapter {
  complete(prompt: string, options?: CompleteOptions): Promise<string>
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>
  /** null when embedding is not available (NoOp etc.) — used for the capability check */
  getEmbeddingInfo(): EmbeddingInfo | null
}
```

### 4.2 Implementations

- **bedrock.ts**: Titan v2 (`InvokeModel`), with `dimensions: 1024` specified explicitly.
  `embedBatch` calls in parallel (Titan has no batch API, so concurrency is capped with p-limit).
  When the model ID is `cohere.embed*` it switches to the Cohere shape (a `texts` array plus the
  query/document asymmetry of `input_type`, a true batch of up to 96 items per call) — so that
  Cohere Embed v4 (128K tokens, available in the Tokyo region) can be evaluated as a challenger
  to Titan
- **ollama.ts**: `POST /api/embed` (batch supported). The model name comes from env
  (default `bge-m3`)
- **noop.ts**: `getEmbeddingInfo()` → `null`, `embed()` throws
- **openai.ts**: implemented the same way with `text-embedding-3-small`. Its role is as a
  **connector for OpenAI-compatible endpoints** (pointing `baseUrl` at a self-hosted inference
  server such as vLLM / HuggingFace TEI). The officially supported paths are Bedrock and Ollama

### 4.3 Environment variables (`packages/shared/env.ts`)

| Variable             | Default                | Purpose                                   |
| -------------------- | ---------------------- | ----------------------------------------- |
| `AI_EMBEDDING_MODEL` | implementation default | Overrides the embedding model per adapter |

> An operational kill switch (env `SEARCH_HYBRID`) was considered at one point but **dropped**.
> Provider outages degrade automatically via timeout + BM25 fallback (§7.4), and stopping for
> quality or cost reasons is designed as **an action from the admin screen**
> (ADR-034 open issue 8, follow-up).

## 5. Step 2: DB Schema + Infrastructure

### 5.1 Migration (`packages/db`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE package
  ADD COLUMN embedding vector,            -- no dimension (no DDL when swapping models)
  ADD COLUMN embedding_model text,        -- vector-space key "model name@dimensions" (embeddingKey(), for mismatch detection)
  ADD COLUMN embedding_hash text;         -- SHA-256 of the source text (skips re-embedding)
```

- HNSW / IVFFlat indexes are **not** created (v1 is exact search; ADR-034 §2)
- Search only considers rows where `embedding_model = <current key>`. Because the key is
  "model name@dimensions", a Matryoshka model (Titan v2 etc.) that changes dimensions under the
  same name is treated as a different space, so a mix during migration does not make pgvector
  raise a dimension-mismatch error

### 5.2 compose.yml

- Change the `postgres` image to `pgvector/pgvector:pg16`.
  **Recreating the volume is recommended for dev environments** (collation differences between
  alpine and Debian; ADR-034 impact)
- Add an Ollama service (shared dev/on-premises configuration, dev/prod parity):

```yaml
ollama:
  image: ollama/ollama
  ports:
    - '127.0.0.1:${OLLAMA_PORT:-11435}:11434' # 11435: avoids clashing with a native Ollama
  volumes:
    - ollama-models:/root/.ollama # for closed networks, ship this volume in advance
```

- Started in the default stack (no profile needed). The model is pulled automatically by
  `ollama-init` (a one-shot container) only when `AI_TYPE=ollama`. It is skipped when already
  pulled or in a closed network (volume shipped in advance)

### 5.3 AWS (infra/)

- `CREATE EXTENSION` runs as part of the migration against Aurora (no extra CDK change)
- Bedrock embeddings are **enabled by default** (opt out with `EnvironmentConfig.bedrock: false`) —
  environment variables such as `AI_TYPE=bedrock` are injected into both the web and worker tasks,
  and `bedrock:InvokeModel` is allowed only against the foundation-model ARN of the target model
  (the model ID is resolved on the CDK side and shared between env and IAM)
- No advance Bedrock model-access setup is required (the model access page has been retired —
  serverless foundation models are enabled on first invocation and access control is consolidated
  in IAM)
- The default threshold **lives inside each AI adapter**
  (`EmbeddingInfo.recommendedMinSimilarity`; measured on the demo golden set of 39 queries,
  2026-07-07. The cosine-similarity distribution for Japanese pairs differs greatly per model,
  so a single default cannot be reused):
  - Titan v2 → **0.15** (keeps 97% of peak performance, one spurious hit on queries with no
    correct answer)
  - Cohere Embed v4 → **0.3** (99% of peak, 0–1 spurious hits)
  - bge-m3 (Ollama) → **0.45** (measured on real data: relevant 0.47–0.62 / noise 0.38–0.45)
  - Resolution order: env `SEARCH_VECTOR_MIN_SIMILARITY` (`bedrock.vectorMinSimilarity` in CDK) >
    adapter recommendation > fallback 0.45. Even for deployments that do not use CDK
    (compose / on-premises), simply choosing a model gives you the right threshold. Re-measure
    when the model changes
  - Against this baseline, an offset of **±4 notches (0.025 per notch)** can be applied from the
    admin screen (`/dashboard/admin/site`) without redeploying. Semantic search as a whole can
    also be toggled on/off from the same screen (when off, query embedding is skipped entirely).
    Both live in the `system_setting` table and take effect within 30 seconds (ADR-036)
- **Measured model-selection results**: Cohere Embed v4 (nDCG 75) > Titan v2 (nDCG 70),
  by +12pt in particular on question-form queries. However, Cohere is an **AWS Marketplace
  model**, so a one-time invoke with administrator privileges (plus a few minutes of propagation)
  is required to activate the account subscription — the default is therefore the friction-free
  Titan, with Cohere as an opt-in in environments.ts

## 6. Step 3: Embedding Generation Pipeline

### 6.1 Queue job

- New job type `embed-package` (payload: `{ packageId }`)
- Enqueue sites: added to the package index update (`indexPackageMetadata()`) in
  `services/search-index.ts` **and** to the resource index update
  (`indexResourceMetadata()`) — the parent package is re-embedded on resource CUD as well,
  because resource metadata is part of the embedded text
- The enqueue condition is **capability only** (`getEmbeddingInfo() !== null`). It is not gated
  on `SEARCH_HYBRID` — that flag is an emergency switch that only stops _reading_ vectors at
  search time; writes continue while it is paused, guaranteeing the vectors are not stale when
  it is re-enabled
- No extra handling on package deletion, since the row disappears with it

### 6.2 Worker handler (`apps/worker`)

1. Fetch the package (finish if deleted)
2. Build the target text (concatenating the metadata of active resources, truncated at the token
   limit):
   `title + '\n' + notes + '\n' + tags.join(' ') + '\n' + resources.map(r => r.name + ' ' + (r.description ?? '')).join('\n')`
3. Compare the SHA-256 against `embedding_hash` → skip when it matches and `embedding_model`
   matches too
4. `embed(text, { type: 'document' })` →
   `UPDATE package SET embedding, embedding_model, embedding_hash`
5. On failure, ride the existing retry mechanism (a missing embedding only lowers search quality,
   it does not break functionality)

### 6.3 Bulk re-embedding

- Add the equivalent of `--embeddings` to the existing search index rebuild flow:
  process every active package with `embedBatch` (with rate limiting)
- Procedure for swapping model/dimensions: change env
  (`AI_EMBEDDING_MODEL` / `AI_EMBEDDING_DIMENSIONS`) → run rebuild (every row whose
  `embedding_model` key no longer matches is regenerated)

## 7. Step 4: Hybrid Search

### 7.1 Vector search (added to the PG implementation in `packages/adapters/search`)

```typescript
/** top-k by pgvector cosine distance. The visibility WHERE from SearchFilters must always be applied.
 *  modelKey is the vector-space key "model name@dimensions" from embeddingKey() (not a bare model name) */
searchByVector(vector: number[], modelKey: string, filters: SearchFilters, k: number): Promise<VectorHit[]>
```

- `ORDER BY embedding <=> $vector LIMIT k` (k=50)
- Similarity threshold: exclude anything below a cosine similarity of **0.45 by default** — this
  prevents kNN from filling all k slots with unrelated results. Measured on real data with
  bge-m3, relevant hits land at 0.47–0.62 while the unrelated tail sits at 0.38–0.45. Because it
  is model-dependent it can be tuned per environment with `SEARCH_VECTOR_MIN_SIMILARITY` (the
  final value is settled by the golden-set evaluation)
- Not implemented for the OpenSearch adapter (vectors are consolidated on PG; ADR-034 option P)

### 7.2 RRF fusion (service layer, shared across environments)

```
score(doc) = Σ 1 / (60 + rank_i(doc))   // BM25 rank + vector rank
```

- BM25 top-50 + vector top-50 → RRF → apply offset/limit
- matchedResources / highlights are carried over from the BM25 results
- facets add the vector-only hits inside the window to the BM25 aggregation (`facetsForIds`),
  and total is max(BM25 total, fused count) — both share the same approximation, namely that the
  vector side contributes only up to FUSION_WINDOW
- Paging: within the range of the fused list (at most 2×FUSION_WINDOW items) the response follows
  the fused order. Only when the start position goes past the fused list _and_ the BM25 total
  reaches that far does it fall back to keyword-order paging — this prevents the accident where
  the total reported by the first page contradicts later pages and you step onto an empty page
- Docs hit only by the vector side get `matchSource: 'semantic'` and no highlights
- When `q` is empty (browsing), vector search is not run (existing behavior unchanged)

### 7.3 Query embedding cache

- The lru-cache utility in `packages/shared` (ADR-004)
- Key: `${model}:${normalizedQuery}`, TTL 1h / max 1000 entries

### 7.4 API

- Add a `semantic` parameter to `GET /api/v1/search` (default `true`)
- Degrade conditions (BM25 only under any of these): `semantic=false` /
  `getEmbeddingInfo() === null` / query embedding failure or **timeout** (log an error only; the
  search still succeeds. The timeout is set short — around 2s — to keep a provider outage from
  making every search slow)
- The MCP dataset search tool goes through the same service, so no extra implementation

## 8. Step 5: Web UI (`apps/web`)

- Search results page: minimal changes. Vector-derived hits (`matchSource: 'semantic'`) have no
  highlights, so title/notes are shown as plain text with a "related" badge
- i18n: badge wording (ja/en)
- A search settings UI (semantic ON/OFF toggle) is not built in v1 (URL parameter only)

## 9. Step 6: Golden-Set Evaluation

- `packages/api/scripts/golden-queries.yaml`: 20–50 questions (always mixing synonyms / natural
  language / **exact matches**). Written by hand after real data is loaded. It is specific to the
  deployed environment so it is not committed; copy it from `golden-queries.example.yaml`
  (which includes a filling-in guide) in the same directory
- `packages/api/scripts/eval-search.ts` (`pnpm eval:search`): hits the search API and prints
  Recall@10 / nDCG@10 compared between semantic ON and OFF. Exits 1 when it detects regression on
  exact-match queries
- **Shipping condition**: no regression on exact-match queries relative to `semantic=false`
  (ADR-034 decision 8). If there is regression, tune the RRF weights and threshold; if that does
  not resolve it, ship with the default switched to OFF

## 10. Test Strategy

| Kind        | Target                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Unit        | RRF fusion logic, target-text generation + hash, EmbedOptions branching                                     |
| Unit        | Adapters: the noop capability; ollama/bedrock with mocked HTTP                                              |
| Integration | pgvector queries (including the visibility filter), the embed-package job, rebuild                          |
| E2E         | Hybrid search with the Ollama profile up → confirm synonym hits; `semantic=false` matches existing behavior |

## 11. Implementation Order

1. **Step 1**: AIAdapter extension + implementations (bedrock / ollama / openai / noop)
2. **Step 2**: Migration + compose.yml (pgvector image, Ollama profile)
3. **Step 3**: embed-package job + rebuild extension
4. **Step 4**: Vector search + RRF + API parameter
5. **Step 5**: Web UI (badge, plain display)
6. **Step 6**: Evaluation script (the golden set itself comes after real data)

Steps 1–3 and Step 4 are largely independent, so Step 4 can start before Step 3 is finished
(it simply runs with few embedded rows).

## 12. Out of Scope (follow-ups)

- Embedding resource content (PDFs etc.) → ADR-034 open issue 5 (including re-evaluating the
  vector store)
- Related-dataset recommendation ("similar datasets") → ADR-034 open issue 6
- Stopping hybrid search from the admin screen (operational stop for quality or cost reasons) →
  ADR-034 open issue 8
- ADR-032 Part B (`query_resource`) → carried out independently of this phase
- Final choice of embedding model → after the golden-set evaluation
