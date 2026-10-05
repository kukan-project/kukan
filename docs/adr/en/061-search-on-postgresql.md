# ADR-061: Move search to PostgreSQL (start with the passage index; retire OpenSearch if it passes)

## Status

**Proposed — measure pass/fail in stage 1 (the passage index) before deciding on retirement** — 2026-10-05

Keyword search moves from OpenSearch to PostgreSQL. Japanese morphological analysis is done in the
application, and the result goes into PostgreSQL's built-in `tsvector` with a GIN index. Ranking is
BM25 written in SQL. Nothing depends on an extension (PGroonga, BM25 extensions), so RDS, Aurora and
Docker Compose run the same configuration.

The move **starts with the passage index for document text**, which is being built new for RAG. The
passage index is built on PostgreSQL from the start. If its evaluation passes, dataset and resource
search follow and OpenSearch is retired. If it fails, OpenSearch stays for keyword search only
(see Stages and pass criteria).

If accepted, this supersedes ADR-009 and replaces the OpenSearch-dependent parts of ADR-021 and ADR-025.

## Context

### 1. What OpenSearch does today

- Japanese analysis with kuromoji. Base forms, part-of-speech removal, prefix removal (`ja_prefix`),
  stopwords and request boilerplate (`ja_request_words`), applied differently on the index side and the
  query side
- A parent-child index (ADR-025). Datasets are parents; resource metadata and text chunks are children.
  Datasets are ranked by the maximum `has_child` score, and `inner_hits` returns up to 100 matched resources
- Highlights. Dataset and resource metadata are highlighted with the search; text is fetched lazily after display
- Facets. The format facet is counted from a children aggregation
- Text is indexed in 500KB chunks (ADR-021)

Some of it already lives outside OpenSearch:

- Vectors are in pgvector (ADR-034, ADR-054). The fusion of BM25 and vectors (RRF) happens in the service
  layer and does not depend on the backend
- `PostgresSearchAdapter` always runs, for the dashboard and for vector search (ADR-013). It already has
  the filters, facets and visibility checks. Only the text matching is ILIKE + pg_trgm (ADR-009)

### 2. The cost of being outside

- **Fixed cost.** Depending on scale, a t3.small.search, an m6g.large.search, or two m6g.xlarge.search
  (Multi-AZ) run all the time. Compose needs a container with a 2GB heap
- **Consistency machinery.** Because the index is outside the database, the following were built and are maintained:
  - pending flags and a job that applies them in batches (`sync-search-docs`, `doc_sync_due_at`)
  - a sync lock and CAS for resource documents
  - rebuilding the index and swapping the alias when the analysis changes
    (`analysisStale` / `reanalyseIndex` / `pendingRepair`)
  - returning 503 when it is down
- **Deploy compatibility.** A mapping change either can be added to the live index or needs a rebuild, and
  every release has to check which

ADR-058 moved the job queue to PostgreSQL and removed SQS. Search is the last piece of infrastructure
that keeps state outside the database.

### 3. What RAG adds

There is a plan to let resident-facing RAG and external AI (MCP) retrieve the passages that support an
answer, with citations. What it needs is easier to build outside OpenSearch:

- **A passage index for document text.** Units of about 1,000–2,000 characters along heading and page
  boundaries, each with its text, a context sentence, page, heading and embedding. A passage must
  disappear as soon as its resource is made private, and passages of an old version must not remain after
  the version is replaced. On OpenSearch, the machinery in §2 would be built again for passages
- **Filtering on extended metadata each site defines.** Document kind, comment or inspection periods,
  target neighbourhoods, and so on. On OpenSearch, the shared domain's mapping grows with every site's
  fields, and each change to a field means rebuilding the index
- **Query expansion at search time from a synonym and place-name dictionary.** A dictionary update must not
  require rebuilding the index. Search-time synonyms on AWS OpenSearch need custom packages to be
  distributed and reloaded, which does not suit per-site operation
- **MCP passage retrieval without calling generative AI.** In environments without AI (including closed
  networks) there are no vectors, so **keyword search quality is RAG quality**

### 4. Constraints on the PostgreSQL side

- **RDS and Aurora offer neither PGroonga nor any BM25 extension (pg_search, pg_textsearch, vchord_bm25).**
  pg_bigm is the only one aimed at Japanese (AWS extension list as of 2026-10)
- Built-in full-text search does not segment Japanese. The `to_tsvector` parser treats a run of
  Japanese without spaces as one word
- A `tsvector` is capped at 1MB, and positions stop at 16,383. A 500KB chunk put in as is comes close to the cap
- `ts_rank` / `ts_rank_cd` have no IDF. A word found in every document weighs the same as a rare one
- `ts_headline` re-segments the text with its own parser, so its boundaries do not match words segmented
  in the application

## Options considered

### A) Keep OpenSearch and put RAG on it too

The current analysis and scoring carry over. In exchange, the consistency machinery for passages,
per-site mappings and synonym distribution get built for OpenSearch. Passage vectors go in pgvector per
ADR-034, so the database has to grow anyway. OpenSearch becomes a second copy for BM25, and its fixed
cost remains.

### B) PGroonga

It has morphological analysis (TokenMecab), highlighting and query expansion (`pgroonga_query_expand`).
But it is not available on RDS or Aurora (the reason ADR-009 rejected it). Using it everywhere means
running PostgreSQL ourselves and rebuilding backup, PITR and failover (ADR-037). Using it on-premises
only leaves three search implementations: OpenSearch, PGroonga and ILIKE.

### C) Build on pg_bigm

It works on RDS and Aurora and is language-independent. But with no morphological boundaries it finds
partial matches across word boundaries at the cost of matches that mean nothing as words ("京都" inside
"東京都"). One-character searches cannot use the index, and it has no IDF. Compose would need a database
image with pg_bigm (why ADR-009 rejected it as a middle layer). It stays as a possible supplement for
partial matches (Open issues).

### D) Analyse in the application and search with the built-in `tsvector` and our own BM25 — adopted (proposed)

No extension is needed, and every environment behaves the same. With the analyser and dictionary
(IPADIC) matched to today's kuromoji, the current analysis rules carry over. IDF and highlighting have to
be built by us, and their quality and speed decide whether this works. That is why it goes in measured stages.

## Decision (proposed)

### 1. Analysis happens in the application

- A Node morphological analyser segments both the indexed text and the query. The dictionary is IPADIC,
  matching today's kuromoji
- The rules carry over from today's analysis: base forms, part-of-speech removal, `ja_prefix`, and on the
  query side only `ja_stop` (metadata only) and `ja_request_words`
- The segmented words become a `tsvector` through `to_tsvector('simple', …)` with a GIN index. The query is
  built as an AND in `to_tsquery('simple', …)` (as today's `operator: and`)
- **The analyser is chosen in stage 1.** The candidates are kuromoji.js and Lindera. The criteria are:
  - whether it segments like OpenSearch kuromoji's default search mode (which also splits compounds)
  - whether its dictionary fits in the web task's memory (512MB at scale small)
  - whether it is still maintained

### 2. Ranking is BM25 written in SQL

- Per-word document frequency (df), document length and average length are kept in tables
- The GIN index narrows the candidates, and only the candidates are rescored with BM25
- Field weights (today's `title^3 name^2` and so on) are expressed with a `tsvector` per field or with `setweight`
- df may be updated in periodic batches. A few new documents barely move IDF

### 3. Text is held in passages

- `resource_passage` (tentative) holds text, context sentence, page, heading, version, `tsvector` and embedding side by side
- The 500KB chunk index is replaced by passages in stage 3. The `tsvector` cap in §4 is not a concern at passage size
- Highlights are added in the application, by segmenting the matched passage with the same analyser as the query

### 4. Vectors use halfvec and an HNSW index

With passages, vectors are two to three orders of magnitude more numerous than with resources. They are
looked up with an HNSW index rather than a full scan.

Whether filtered searches lose results is checked. Whether pgvector's iterative scan is available on the
RDS and Aurora versions in use is confirmed in stage 1.

### 5. Search columns are written in the same transaction as their source

Visibility changes, deletions and version replacements reach the search columns and passage rows at once.
After retirement, the consistency machinery in Context §2 goes. Reanalysis after a rule change remains,
as a recomputation inside the database.

### 6. Extended metadata and dictionaries are built on PostgreSQL only

Filtering on extended metadata and query expansion from the synonym and place-name dictionary are not
built on OpenSearch. If stage 1 fails and OpenSearch stays, the filters are combined as candidate
narrowing on the database side.

### 7. The database takes the load

- Rate limits on MCP and the public search API are a precondition for retirement
- Search queries carry a `statement_timeout`. At some scales, search moves to a reader
- Scale small (`db.t4g.micro`) does not offer passage vector search. The scale from which it is offered is
  decided from stage 1's measurements

## Stages and pass criteria

### Stage 1: build the passage index on PostgreSQL

It runs alongside OpenSearch. Dataset and resource search stay on OpenSearch.

The pass criteria are:

- Add passage-level evaluation (Recall@k / nDCG) to `pnpm eval:search`, and measure **with and without AI**.
  Compare the no-AI result with passages put into OpenSearch (kuromoji + BM25)
- Measure p95 search latency in an environment with thick document text
- Measure how database size, memory and the time of a full reprocess grow

### Stage 2: move dataset and resource search

The pass criterion is that the golden set's overall stays within a margin of today's OpenSearch. The
margin is decided before stage 1 starts (suggestion: 3 points).

### Stage 3: retire OpenSearch

The following go:

- the OpenSearch adapter
- the CDK domain and the Compose service
- the consistency jobs and pending flags
- `SEARCH_TYPE`

With no environment difference left, the search adapter boundary is also removed, following ADR-005.

### If it fails

The expected main cause of failure is keyword search quality without AI. In that case OpenSearch stays for
keyword search only, and passages are also put into OpenSearch.

The passage table and vectors built in stage 1 are used as they are.

## Consequences

- **Cost.** The OpenSearch domain's fixed cost goes away. The database has to grow instead. The net per
  scale is worked out from stage 1's measurements
- **Multi-site.** Sites sharing a database affect each other through the passage index and search load. This
  is the same as today's shared OpenSearch domain
- **Migrating existing environments.** Passages and search columns can be rebuilt from the database and the
  originals (a full reprocess). Removing the domain is announced in release notes and done in the
  retirement release
- **Compose.** The OpenSearch container goes, and the memory requirement drops
- **Admin screens.** The index browser (index stats, document browsing, chunk lists) is rebuilt

## Open issues

- Choice of analyser (Decision §1)
- One-character words and partial matches across morphological boundaries: use pg_bigm as a supplement, or keep ILIKE
- When to update df, and the unit that keeps it from being aggregated across sites
- The CKAN-compatible API's `q` (still treated as keywords; unchanged)
- Cost estimates per scale

## Related ADRs

- ADR-005: Adapters only where environments differ
- ADR-009: Japanese full-text search with OpenSearch + ILIKE fallback (superseded if accepted)
- ADR-013: Separation of search and DB filtering
- ADR-021: Resource content full-text search
- ADR-025: OpenSearch parent-child index
- ADR-034: Metadata vector search
- ADR-037: Scale-linked backup strategy
- ADR-041: Multi-site deploy
- ADR-053: AI-generated resource summaries
- ADR-054: The embedding unit is the resource
- ADR-058: Job queue on PostgreSQL
