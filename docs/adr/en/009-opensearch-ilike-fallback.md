> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/009-opensearch-ilike-fallback.md`](../jp/009-opensearch-ilike-fallback.md).

# ADR-009: Japanese Full-Text Search with OpenSearch + ILIKE Fallback

## Status

Revised (2026-03-17) — Added pg_trgm GIN indexes
Revised (2026-03-08) — Previous: pg_bigm adoption (2026-03-01)

## Context

Phase 1 implements PostgreSQL full-text search as a fallback search mechanism, but
PostgreSQL's standard `to_tsvector` does not support Japanese tokenization.

Municipal data primarily consists of Japanese titles and descriptions,
so Japanese search must be functional as of Phase 1.

The previous ADR-009 adopted pg_bigm, but the approach was changed for the following reasons:

- pg_bigm requires a custom PostgreSQL Docker image (no Alpine package available)
- For small-scale deployments, ILIKE is practically sufficient
- For medium-to-large-scale deployments, OpenSearch should be used instead of pg_bigm
- pg_bigm is not worth the maintenance cost as a "middle tier"

## Options Considered

### A) OpenSearch + ILIKE Fallback — Selected

- Pros:
  - OpenSearch natively supports Japanese morphological analysis (kuromoji)
  - Advanced search features: scoring, facets, suggestions, etc.
  - Supports both AWS OpenSearch Service and Docker containers, fitting the hybrid deployment model
  - ILIKE fallback requires no additional extensions and works in all environments
  - Only two search backends needed (OpenSearch / PostgreSQL ILIKE)
- Cons:
  - OpenSearch container requires a minimum of 512 MB to 1 GB RAM
  - ILIKE performs a full scan on large datasets (acceptable for small to medium scale)

### B) pg_bigm (previous decision)

- Pros: 2-gram indexing is language-independent, Aurora PostgreSQL compatible
- Cons:
  - Requires a custom Docker image (not available in postgres:16-alpine)
  - Cannot search for single characters
  - OpenSearch is needed anyway at medium-to-large scale → maintenance cost of the middle tier is wasted

### C) PGroonga

- Pros: High-precision Japanese morphological analysis
- Cons: Not compatible with Aurora PostgreSQL, conflicts with the hybrid deployment strategy

### D) mecab + pg_trgm

- Pros: High morphological analysis precision
- Cons: mecab dictionary management is cumbersome, not compatible with Aurora PostgreSQL

## Decision

**OpenSearch as the production search engine, PostgreSQL ILIKE as the fallback.**

| Deployment Scale             | Search Engine    | SEARCH_TYPE  |
| ---------------------------- | ---------------- | ------------ |
| Small-scale / Development    | PostgreSQL ILIKE | `postgres`   |
| Medium-to-large / Production | OpenSearch       | `opensearch` |

### PostgreSQL ILIKE Fallback + pg_trgm GIN Indexes

- ILIKE search on `package.name`, `package.title`, `package.notes`
- Resource-level ILIKE search on `resource.name`, `resource.description` (via EXISTS subquery)
- **pg_trgm GIN indexes** accelerate ILIKE queries (index effective for queries of 3+ characters)
- pg_trgm is a PostgreSQL contrib module (pre-installed in all environments including Aurora Serverless)
- Transparently accelerates existing ILIKE queries (no code changes required, index takes effect automatically)
- `escapeLike()` escapes LIKE special characters (shared via `@kukan/shared`)
- Queries of 1-2 characters fall back to a full scan (practically acceptable)

### OpenSearch (Implemented in Phase 3)

- Japanese morphological analysis with the kuromoji analyzer
- Supports both Docker containers (`opensearchproject/opensearch`) and AWS OpenSearch Service
- In Docker Compose, opt-in startup via `profiles: [opensearch]`
- OpenSearchAdapter switches on `SEARCH_TYPE=opensearch`

## Implementation

### PostgresSearchAdapter (ILIKE + pg_trgm)

```typescript
// packages/adapters/search/src/postgres.ts
// With pg_trgm GIN indexes, ILIKE queries of 3+ characters automatically use the index
const pattern = `%${escapeLike(query.q)}%`
const results = await db
  .select()
  .from(packageTable)
  .where(
    or(
      ilike(packageTable.name, pattern),
      ilike(packageTable.title, pattern),
      ilike(packageTable.notes, pattern),
      // Resource metadata is also included in search
      sql`EXISTS (
        SELECT 1 FROM resource
        WHERE resource.package_id = package.id
        AND resource.state = 'active'
        AND (resource.name ILIKE ${pattern} OR resource.description ILIKE ${pattern})
      )`
    )
  )
```

### pg_trgm Migration

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Package level
CREATE INDEX idx_package_title_trgm ON package USING GIN (title gin_trgm_ops);
CREATE INDEX idx_package_notes_trgm ON package USING GIN (notes gin_trgm_ops);
CREATE INDEX idx_package_name_trgm ON package USING GIN (name gin_trgm_ops);
-- Resource level
CREATE INDEX idx_resource_name_trgm ON resource USING GIN (name gin_trgm_ops);
CREATE INDEX idx_resource_description_trgm ON resource USING GIN (description gin_trgm_ops);
```

### Phase 3: OpenSearch in Docker Compose

```yaml
# docker/compose.yml
services:
  opensearch:
    image: opensearchproject/opensearch:3
    profiles: [search]
    environment:
      - discovery.type=single-node
      - plugins.security.disabled=true
      - OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
    ports:
      - '9200:9200'
    volumes:
      - opensearch-data:/usr/share/opensearch/data
```

### Phase 3: OpenSearchAdapter

```typescript
// packages/adapters/search/src/opensearch.ts
// Docker container: endpoint = http://localhost:9200
// AWS OpenSearch Service: endpoint = https://xxx.region.es.amazonaws.com
// AWS environments use IAM role authentication, containers use basic authentication
```

## Dual Adapter Configuration

Even in `SEARCH_TYPE=opensearch` environments, PostgresSearchAdapter is always instantiated as `dbSearch` (see ADR-013).
The dashboard (`my_org=true`) queries the DB directly via `dbSearch`, avoiding the effects of index synchronization delays.
Public search uses `search` (OpenSearch) to leverage kuromoji morphological analysis.

In `SEARCH_TYPE=postgres` environments, `search` and `dbSearch` share the same instance, so there is no additional cost.

## Consequences

- pg_trgm GIN indexes make ILIKE search practical even at scales of thousands to tens of thousands of records (both packages and resources)
- Phase 3a: OpenSearch 3.x added to Docker Compose (opt-in via `profiles: [search]`), OpenSearchAdapter implemented
- No custom PostgreSQL Docker image required (stock `postgres:16` used as-is)
- No non-standard extensions like pg_bigm / PGroonga required
- PostgresSearchAdapter is also used as `dbSearch` for the dashboard, ensuring DB consistency across all environments
