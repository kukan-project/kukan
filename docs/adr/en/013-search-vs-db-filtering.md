> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/013-search-vs-db-filtering.md`](../jp/013-search-vs-db-filtering.md).

# ADR-013: Separation of Responsibilities Between Full-Text Search and DB Filtering

## Status

**Accepted**

## Context

CKAN delegates nearly all dataset listing, filtering, and keyword search to Solr. While this design is powerful for faceted search, it has the following known operational issues:

- Newly created datasets may not appear in listings due to DB → Solr index sync delays
- `search-index rebuild` is required when the Solr index is corrupted or inconsistent
- A search engine failure affects the entire site, including listing pages

KUKAN uses OpenSearch as its search engine (ADR-009), but a decision is needed on whether to delegate all queries to the search engine or to differentiate between search engine and direct DB queries.

## Options Considered

### A) All Queries via Search Engine (CKAN approach)

- Pros: Facet counts and relevance scoring are uniformly available across all pages
- Cons:
  - Index sync delays affect listing pages
  - Entire site becomes non-functional during search engine failures
  - Search engine becomes mandatory even for small deployments (LGWAN, etc.)
  - All fields used for filtering must be included in the index

### B) Direct DB + Search Engine Responsibility Separation — Adopted

- Pros:
  - Listings and filtering always show the latest data (DB as Single Source of Truth)
  - Listing and filter pages are unaffected by search engine failures
  - Index is lightweight, containing only fields needed for keyword search
  - Basic functionality works fully without a search engine in small deployments
- Cons:
  - Combined keyword + filter search requires coordination between search engine and DB

## Decision

**Public search goes through SearchAdapter (OpenSearch), while dashboard listings and management always query the DB directly (PostgreSQL).**

### Responsibility Assignment

| Operation                                 | Data Source                      | Endpoint                              |
| ----------------------------------------- | -------------------------------- | ------------------------------------- |
| Public keyword full-text search           | `search` (SearchAdapter)         | `GET /api/v1/search?q=...`            |
| Public listing (search, filters, facets)  | `search` (SearchAdapter)         | `GET /api/v1/packages`                |
| CKAN-compatible search                    | `search` (SearchAdapter)         | `GET /api/3/action/package_search`    |
| **Dashboard listing and management**      | **`dbSearch` (PostgreSQL only)** | `GET /api/v1/packages?my_org=true`    |
| Organization / group listing              | Direct DB                        | `GET /api/v1/organizations`, `groups` |
| Organization detail (affiliated datasets) | Direct DB                        | `GET /api/v1/organizations/:id`       |
| Package detail / resource listing         | Direct DB                        | `GET /api/v1/packages/:id`            |

### Dual Adapter Architecture

Two SearchAdapter instances are injected into AppContext:

| Context Variable | Adapter                                     | Purpose                        |
| ---------------- | ------------------------------------------- | ------------------------------ |
| `search`         | Per configuration (OpenSearch / PostgreSQL) | Public search and index writes |
| `dbSearch`       | Always PostgresSearchAdapter                | Dashboard reads                |

```typescript
// packages/api/src/adapters.ts
const dbSearch = new PostgresSearchAdapter(db) // Always PostgreSQL
let search =
  env.SEARCH_TYPE === 'opensearch'
    ? new OpenSearchAdapter({ endpoint: env.OPENSEARCH_URL })
    : dbSearch // Shared when postgres
```

`dbSearch` is used when `my_org=true` (dashboard):

```typescript
// packages/api/src/routes/packages.ts
const search = my_org ? c.get('dbSearch') : c.get('search')
```

This ensures:

- **Dashboard**: Latest data is displayed immediately after CUD operations (DB as Single Source of Truth)
- **Public search**: OpenSearch kuromoji morphological analysis and relevance scoring are available
- **Index writes**: Index is updated immediately on `search` (OpenSearch) during CUD operations
- **SEARCH_TYPE=postgres**: `search` and `dbSearch` are the same instance, with no additional cost

### Combined Keyword + Filter Search Strategy

When both keyword and filters are specified in SearchAdapter:

- **OpenSearch**: Filtering via filter context (bool filter that does not affect scoring)
- **PostgreSQL**: Filtering via ILIKE + WHERE clause

Filter fields (`organization`, `tags`, `formats`, etc.) are stored in the search engine, and SearchAdapter handles filtering, facet aggregation, and pagination consistently.

### Resource Metadata Search

When the `q` parameter is specified, the search targets not only the package itself (name/title/notes) but also the name/description of associated resources. When matching resources are found, they are included in the response as a `matchedResources` array.

- **OpenSearch**: Search via nested query + inner_hits
- **PostgreSQL**: ILIKE search via EXISTS subquery

## Impact

- Dashboard uses `dbSearch` (PostgreSQL only), so it is unaffected by index sync delays
- Public search uses `search` (OpenSearch) for high-precision Japanese full-text search
- `indexPackage()` immediately updates the `search` adapter index during CUD operations
- In closed network environments such as LGWAN, all features work fully with `SEARCH_TYPE=postgres`
- When `SEARCH_TYPE=postgres`, `search` and `dbSearch` are the same instance with no additional cost

## Related ADRs

- ADR-005: Four Adapters Only (SearchAdapter)
- ADR-009: OpenSearch + ILIKE Fallback
