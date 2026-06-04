> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/021-resource-content-indexing.md`](../jp/021-resource-content-indexing.md).

# ADR-021: Full-Text Search Index for Resource Content Data

## Status

**Accepted** — 2026-04-18 (Decision 1 superseded by ADR-025)

## Context

KUKAN's search currently targets only metadata (dataset name, description, tags, resource name, etc.).
There is a need to search datasets by CSV contents or text file content.

The Pipeline's Index step (currently a no-op) was revived to design the extraction and ingestion of text into OpenSearch.

### Design Decision Points

There are 7 major design decisions.

---

## Decision 1: Extend existing index vs. separate index

### Options

| Option | Configuration                                                     | Pros                                                           | Cons                                                                                       |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A      | Add `extractedText` field to nested resources in `kukan-packages` | Queries complete within a single index                         | Document size bloat (100KB × number of resources), metadata search performance degradation |
| B      | **Create a separate index `kukan-resources`**                     | No impact on metadata search, independent lifecycle management | Requires `msearch` across 2 indexes + app-layer merging                                    |

### Decision: Option B — Separate index `kukan-resources`

Content text is up to 100KB per resource. With 10 resources per dataset, document size approaches 1MB,
causing an order-of-magnitude increase in `kukan-packages` document size. To maintain metadata search performance
(the majority of queries), content is separated into a dedicated index.

By using the `msearch` API to send 2 queries in 1 round trip, latency increase is minimal.

---

## Decision 2: Where to persist content text

### Options

| Option | Configuration                                                  | Pros                                                                        | Cons                                                      |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| A      | Create a `resource_content` table in the DB                    | Fast re-indexing (SELECT only), can be used for PostgreSQL full-text search | DB size increases (text + GIN index = 5–7× original size) |
| B      | **Do not store in DB. Pipeline → direct OpenSearch ingestion** | No DB size increase, simpler implementation                                 | Re-indexing requires re-download from S3 and re-parsing   |

### Decision: Option B — Do not store content text in DB

Re-indexing frequency is extremely low (only on OpenSearch failures or mapping changes).
S3 re-download cost is low, and the same logic from the Pipeline's Index step can be reused.
DB size savings and implementation simplicity are prioritized.

Truncation information (whether indexed, original size, truncated size) is recorded in the existing `resource_pipeline.metadata` JSONB.

---

## Decision 3: Content search in PostgreSQL fallback

### Options

| Option | Configuration                                                        | Pros                                          | Cons                                                                                    |
| ------ | -------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| A      | `resource_content` table + `gin_trgm_ops` GIN index for ILIKE search | Content search available without OpenSearch   | DB size bloat (100KB × N resources × GIN 3–5×), performance issues beyond 10K resources |
| B      | **No content search in PostgreSQL**                                  | No DB size increase, no `postgres.ts` changes | Air-gapped users cannot use content search                                              |

### Decision: Option B — No content search in PostgreSQL

PostgreSQL mode is primarily for small-scale deployments (development, air-gapped PoC).
Metadata search is sufficient for practical use, and content search is positioned as an OpenSearch value-add.

pg_trgm's GIN index with 100KB text × thousands of resources reaches hundreds of MB to several GB,
unnecessarily inflating DB size in small-scale environments.

---

## Decision 4: Content text size limit

### Analysis

Practical constraints on OpenSearch document size:

| Size    | Assessment                                       |
| ------- | ------------------------------------------------ |
| ~10 KB  | Ideal. Typical search document                   |
| ~100 KB | Good. Long article level                         |
| ~500 KB | Acceptable but impacts indexing speed and memory |
| ~1 MB   | Near upper limit. Increased GC pressure          |

100KB of Japanese text ≈ approximately 30,000–50,000 characters ≈ 40–60 A4 pages.
For CSV, this sufficiently covers thousands of rows of headers + data.

### Decision: 500KB chunks × stream processing × lazy highlights (updated: 2026-04-25)

Initially a 100KB limit with truncation, but migrated to chunk splitting and stream processing.

**Chunk size**: 100KB / 500KB / 1MB were benchmarked on t3.small, with 500KB chosen.

- 100KB: Higher match count per chunk (465 vs 93), frequent JVM Young GC spikes
- 500KB: Good balance between match count and `_source` loading, mostly under 200ms after GC stabilization
- 1MB: Close to `max_analyzed_offset` boundary (1 million characters), larger `_source` decompression cost

**Lazy highlight loading**: Content highlight (snippet) retrieval is separated from the search response.

- Search API (`GET /api/v1/packages`) executes only Stage 1 (msearch + collapse) and
  immediately returns a response containing `_contentDocId`
- Snippets are lazily fetched via `POST /api/v1/packages/highlights` (ids query, no collapse)
- Frontend displays cards first, then asynchronously adds snippets

- `MAX_CONTENT_CHUNK_SIZE = 500 * 1024` (500KB / chunk)
- No chunk count limit (covers entire file size; `MAX_FETCH_SIZE` = 100MB is the practical limit)
- Text formats use stream processing with line-by-line reading via `streamUtf8Lines` (memory usage ~500KB)
- Non-UTF-8 encodings fall back to buffer conversion
- 500KB chunks fit within kuromoji's highlight processing default `max_analyzed_offset` (1 million characters)
- Metadata recorded in `resource_pipeline.metadata`:
  - `contentIndexed`: boolean — whether indexed
  - `contentType`: string — `'tabular' | 'text' | 'manifest'`
  - `contentOriginalSize`: number — total text byte count
  - `contentIndexedSize`: number — actually indexed byte count
  - `contentChunks`: number — number of chunks created

---

## Target Formats

| Format         | Extraction Method                    | contentType |
| -------------- | ------------------------------------ | ----------- |
| CSV / TSV      | UTF-8 conversion → header + row data | `tabular`   |
| TXT / MD       | UTF-8 conversion → plain text        | `text`      |
| HTML / HTM     | UTF-8 conversion → tag removal       | `text`      |
| JSON / GeoJSON | As-is                                | `text`      |
| XML            | UTF-8 conversion                     | `text`      |
| ZIP            | Manifest file name listing           | `manifest`  |
| PDF / Office   | Not supported (future)               | —           |

---

## Decision 5: Where to store resource metadata

### Options

| Option | Configuration                                                                              | Pros                                                                          | Cons                                                                                           |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A      | Keep resource metadata in `kukan-packages` nested, store only content in `kukan-resources` | No changes to existing `kukan-packages` structure                             | Resource search logic split across 2 locations (metadata in nested, content in separate index) |
| B      | **Consolidate resource metadata and content into `kukan-resources`**                       | Single responsibility: "resource search = `kukan-resources`". Simpler mapping | Structural change required to remove nested resources from `kukan-packages`                    |

### Decision: Option B — Consolidate resource metadata into `kukan-resources`

By performing resource name/description search and content search in the same index:

- Search logic is unified (nested queries eliminated)
- Scoring is unified (metadata and content boosts controlled in the same `multi_match`)
- No need to re-index all resources on dataset CUD operations
- Easier to support future resource-level search API

Nested `resources` field is removed from `kukan-packages`, keeping only the `formats` array (for facets).

### Scoring Design

Scores from the 2 indexes are computed independently and merged at the application layer.

**Resource-side field boost:**

```
name^3 > description^2 > extractedText (no boost)
```

**Dataset final score:**

```
finalScore = packages_score + max(resource_scores) * RESOURCE_BOOST
```

- `packages_score`: BM25 score from `kukan-packages`
- `max(resource_scores)`: Highest score among resources belonging to the dataset
- `RESOURCE_BOOST`: 0.3–0.5 (configurable constant, tuned during operation)

This ensures datasets with exact metadata matches rank higher than datasets where content merely happens to contain the term.

---

## Decision 6: 3-index separation (content independence)

### Background

The initial implementation co-located resource metadata and content text (`extractedText`)
in `kukan-resources`, but an operational issue was identified.

**Problem**: When rebuilding metadata (`POST /admin/reindex-metadata`), deleting and re-indexing all of `kukan-resources`
also removes content text (generated by Pipeline, requires re-fetching from S3).
Cannot handle the case of rebuilding only metadata without content reprocessing.

### Options

| Option | Configuration                                                      | Pros                                                                  | Cons                                                    |
| ------ | ------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------- |
| A      | Upsert (no full delete)                                            | Content is preserved                                                  | Orphan documents may remain. Partial update is complex  |
| B      | **Separate content into `kukan-contents` (3-index configuration)** | Metadata rebuild doesn't affect content. Clear separation of concerns | msearch increases to 3 queries (but still 1 round trip) |

### Decision: Option B — 3-index configuration

```
kukan-packages  → Dataset metadata (title, notes, tags, org, ...)
kukan-resources → Resource metadata (name, description, format)
kukan-contents  → Extracted text (extractedText, contentType)
```

Each index has an independent lifecycle:

| Operation         | packages              | resources             | contents                           |
| ----------------- | --------------------- | --------------------- | ---------------------------------- |
| Metadata rebuild  | Delete all → re-index | Delete all → re-index | **Not touched**                    |
| Content reprocess | —                     | —                     | Delete all → re-index via Pipeline |
| Normal CUD        | upsert                | upsert                | —                                  |
| Pipeline complete | —                     | —                     | upsert                             |

For future extensions (chunk splitting, embeddings), only the internal structure of `kukan-contents`
needs to change — `kukan-packages` / `kukan-resources` are not affected.

---

## Decision 7: Future chunk splitting and embedding support strategy

### Background

Phase 5 (AI & Semantic Search) plans embedding vector-based semantic search.
Support for content search of large documents such as PDFs is also desired.

### Need for Chunk Splitting

**Keyword search (BM25)** and **Embedding (kNN)** have different optimal chunk sizes.

| Use Case                | Optimal Size          | Reason                                                                |
| ----------------------- | --------------------- | --------------------------------------------------------------------- |
| BM25 keyword search     | ~100 KB               | Longer text provides more match opportunities                         |
| Embedding vector search | ~500 tokens (~1.5 KB) | Model input limit (Titan v2: 8,192 tokens). Too large dilutes meaning |

The single-document approach (Option B) has a practical limit of ~100KB due to highlight performance degradation.
Cannot handle PDFs (hundreds of pages, several MB of text).

### Future Index Configuration (Phase 5)

```
kukan-packages    → Dataset metadata (unchanged)
kukan-resources   → Resource metadata (unchanged)
kukan-contents    → Keyword search text (~500KB chunk splitting)
kukan-embeddings  → Embedding small chunks (~500 tokens × N, with knn_vector field)
```

Since keyword search and embedding have different optimal chunk sizes, they use separate indexes.
When `kukan-contents` is chunk-split, `collapse` field (resourceId) enables
per-resource deduplication.

### Staged Migration Path

1. ~~**Phase 4**: 3-index configuration. 1 resource = 1 document (100KB truncation)~~ → **Implemented (see below)**
2. **Phase 5a**: Add `kukan-embeddings`. Generate embeddings via AIAdapter. Hybrid search (BM25 + kNN)

### Decision (updated: 2026-04-25)

Chunk splitting + lazy highlights were introduced in Phase 4:

- `kukan-contents` uses 1 resource = N documents (500KB chunks × unlimited)
- Stream processing handles large files (up to 100MB)
- `collapse` for per-resource deduplication
- Highlights are lazily fetched via `POST /api/v1/packages/highlights` (separated from search response)
- `kukan-embeddings` to be added in Phase 5

---

## Implementation Overview

1. Pipeline's Index step extracts text → splits into 500KB chunks → ingests into OpenSearch `kukan-contents`
2. Text formats use `streamUtf8Lines` for stream processing (memory efficient)
3. Nested resources removed from `kukan-packages`; resource metadata moved to `kukan-resources`
4. Search uses `msearch` to query 3 indexes in parallel (content uses `collapse` by resourceId, no highlights)
5. Content highlights are lazily fetched via `POST /api/v1/packages/highlights` (`ids` query, no collapse)
6. Metadata rebuild (reindex) does not affect `kukan-contents` (only deleted and rebuilt when `includeContent` is specified)
7. `postgres.ts` changes are minimal (new methods implemented as no-op, existing direct DB queries unchanged)

## Related ADRs

- ADR-009: OpenSearch + ILIKE fallback
- ADR-013: Separation of search and DB filtering
- ADR-014: Preview Parquet format
