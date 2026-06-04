> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/025-opensearch-parent-child-index.md`](../jp/025-opensearch-parent-child-index.md).

# ADR-025: OpenSearch Parent-Child Index Consolidation

## Status

**Accepted** — 2026-05-31

Supersedes ADR-021 (Decision 1).

## Context

The current search consists of 3 OpenSearch indexes:

- `kukan-packages` — Dataset metadata (title, name, notes, organization, tags, etc.)
- `kukan-resources` — Resource metadata (name, description, format, packageId)
- `kukan-contents` — Resource content full-text (extractedText, resourceId, packageId)

`msearch` is used to search 3 indexes in parallel, with the application layer merging results at the package level.
The following issues were identified with this design:

### Issue 1: Facet count inconsistency

Aggregations (aggs) are based only on the package index search results.
Packages matched by resource name or content are added after merging,
so they are not reflected in facet counts.

Example: If "Tokyo Tourism" is not in the package title but is in a resource name,
the search result displays it but the facet count shows 0.

### Issue 2: Facet filter not applied

Resource/content searches do not have facet filters (organization, tags, etc.) applied,
allowing packages that don't match the filter criteria to appear in search results.

### Issue 3: Merge logic complexity

Approximately 200 lines of merge logic are needed, including `mergeResourceHits`, `mergeContentHits`, and `fetchPackagesByIds`.
Maintaining consistency of scoring, pagination, and highlights is difficult.

## Options Considered

| Option                            | Overview                                                          | Pros                                                                               | Cons                                                                               |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A. 2-phase search                 | Phase 1 collects packageIds, Phase 2 uses ids+filter+aggs         | No index changes needed                                                            | Scoring, highlights, and pagination consistency cannot be achieved                 |
| B. Denormalize into packages      | Embed resource names into package documents                       | Single query for search (up to resource names)                                     | Requires package re-indexing on resource update. Content remains in separate index |
| **C. Parent-child consolidation** | Consolidate 3 document types into a single index using join field | Fundamentally resolves all issues. Search, aggs, highlights, pagination in 1 query | Re-indexing work required. Same-shard constraint                                   |

## Decision: Option C — Parent-child index consolidation

### Index Structure

```
kukan-search (single index)
  ├── type: "package"   (parent)
  │     title, name, notes, organization, tags, formats, ...
  ├── type: "resource"  (child of package)
  │     name, description, format
  └── type: "content"   (child of package)
        extractedText, resourceId, contentType
```

OpenSearch's join field supports only 1 level of hierarchy, so
resource and content are both placed flat as children of package.
Content is logically a child of resource, but grandchild (package → resource → content)
is not supported in OpenSearch. Instead, a `resourceId` field is retained, and
resource-level operations (deleteContent, getContentChunks, etc.) use term filters.

### Search Query Example

```json
{
  "query": {
    "bool": {
      "should": [
        { "multi_match": { "query": "Tokyo Tourism", "fields": ["title", "notes"] } },
        {
          "has_child": {
            "type": "resource",
            "query": {
              "multi_match": { "query": "Tokyo Tourism", "fields": ["name", "description"] }
            }
          }
        },
        {
          "has_child": {
            "type": "content",
            "query": { "match": { "extractedText": "Tokyo Tourism" } }
          }
        }
      ],
      "minimum_should_match": 1,
      "filter": [{ "terms": { "organization": ["my-org"] } }]
    }
  },
  "aggs": {
    "organizations": { "terms": { "field": "organization" } }
  }
}
```

### Benefits

- Search, facets, filters, and pagination complete in 1 query
- Merge logic (`mergeResourceHits`, `mergeContentHits`, `fetchPackagesByIds`) is no longer needed
- Facet counts accurately reflect matches from all sources (packages + resources + content)
- Filters are applied uniformly at the package level

### Constraints and Considerations

- **Same-shard constraint**: Child documents are placed on the same shard as the parent (controlled via `routing` parameter)
- **Document count**: Increases to package count × (resource count + chunk count), but not a problem at the scale of tens of thousands of packages
- **Child document updates**: Adding/deleting resources/content requires `routing=packageId`
- **Re-indexing**: Migration from the existing 3 indexes is required
- **inner_hits**: `has_child` + `inner_hits` is used to retrieve resource/content highlights

### Migration Plan

1. New index mapping definition (join field + kuromoji analyzer)
2. Update `OpenSearchAdapter` CRUD methods for the new structure
3. Rewrite search methods to use `has_child` queries (remove merge logic)
4. Create migration script (3 indexes → 1 index)
5. Update admin panel reindex feature for the new structure

## References

- [OpenSearch Join field type](https://opensearch.org/docs/latest/field-types/supported-field-types/join/)
- [OpenSearch has_child query](https://opensearch.org/docs/latest/query-dsl/joining/has-child/)
- ADR-021: Full-text search index for resource content data (Decision 1 superseded by this ADR)
