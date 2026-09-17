> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/025-opensearch-parent-child-index.md`](../jp/025-opensearch-parent-child-index.md).

# ADR-025: OpenSearch Parent-Child Index Consolidation

## Status

**Accepted** — 2026-05-31

Supersedes ADR-021 (Decision 1).

## Context

The current search consists of 3 OpenSearch indexes:

- `kukan-packages` — Dataset metadata (title, name, notes, organization, tags, etc.)
- `kukan-resources` — Resource metadata (name, description, section, format, packageId)
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
  │     name, description, section, format
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

### Leg weights — content must not outvote what a dataset says about itself

A search adds three legs under `should`: the package itself, resource metadata
(`has_child: resource`), and resource content (`has_child: content`). Both child
legs use `score_mode: 'max'`, so **one best chunk** speaks for the leg.

Metadata and content started at the same weight, 0.4, and that breaks. A word
appearing once in a free-text answer among a thousand takes the maximum, and
competes on equal terms with a document whose abstract is about the subject. In
practice the top hit for「お年寄り」was a water-supply survey whose only match
was one respondent's aside.

**The content leg is weighted down.** Measured on the golden set (dev catalogue,
168 packages, 2026-09-17) by sweeping that weight alone:

| content weight | `word` nDCG, keyword leg | fused |
| -------------- | -----------------------: | ----: |
| 0 (off)        |                      62% |       |
| 0.05           |                      67% |       |
| 0.15           |                      67% |   71% |
| 0.25           |                      64% |       |
| 0.4            |                      54% |   66% |

**Lowered, not removed.** At zero it loses five points, so content earns its
place; it simply must not outvote what a dataset says about itself. 0.05 and
0.15 score the same, and 0.15 keeps more of the content signal. `exact` stays at
100% throughout, and `synonym` and `natural` do not move.

**`score_mode` is not the answer.** Measured as the other candidate: `sum` drops
`exact` to 87%, because a long document repeating a name outscores the dataset
that carries it. `avg` was within noise.

### The query side for content — drop the request form and nothing else

Metadata is searched through `kuromoji_query_analyzer` (`ja_stop` plus
`ja_request_words`); extracted text is not. `ja_stop` ships with kuromoji and
drops「こと」「もの」「ため」「する」. Metadata is written to be searched, so
losing those costs it nothing. **Content is the document's own words**, where
「こと」may be the very thing someone is looking for.

The request form does have to go. `operator: 'and'` requires every token, so the
words in「〜を教えてください」become words the document is **required to
contain**. Measured on the dev catalogue, 968 chunks:

| query                                | now | request words dropped |
| ------------------------------------ | --: | --------------------: |
| 防災の取り組み                       |  23 |                    23 |
| 防災の取り組みについて教えてください |   4 |                    23 |
| 子育ての支援制度                     | 222 |                   222 |
| 子育ての支援制度を教えてください     |  42 |                   222 |

**Adding a polite word stops changing the count, and a bare query does not
move.** So content gets `kuromoji_content_query_analyzer`, carrying
`ja_request_words` alone.

**Dropping the all-terms requirement was measured and rejected.**
`minimum_should_match` lifts the keyword leg from 44% to 50%, but the fused
result falls: overall 88% to 87%, `synonym` 94% to 88%. Where metadata matches
nothing, the loosened content matches fill the keyword leg's top and RRF counts
them as first-place votes against a vector leg that was already scoring 94%. It
also costs: more matching chunks means highlighting more 500KB chunks, and the
parent circuit breaker tripped eight times during one evaluation run (limit
2040MB against 352MB at rest). The smallest deployment size has half that heap.

### Updating the analysis (the index name is an alias)

An analyzer is fixed when an index is created. Changing the kuromoji settings
(stopwords, part-of-speech filters) leaves a running deployment analysing as it
always did, and rebuilding — re-sending every document — does not help while the
destination is the same index.

So the search index sits **behind an alias**. The concrete index is numbered,
`<prefix>-search-000001`, and what the application reads and writes is always
the alias `<prefix>-search`. To update the analysis, the next numbered index is
created, `_reindex` copies every document into it, and the alias is swapped.
`extractedText` lives in `_source`, so OpenSearch re-analyses in place: nothing
is fetched, extracted or embedded again, and the whole thing takes seconds
against the hour a content re-processing takes.

Decisions:

- **No automatic migration.** A deployment created before the alias keeps
  working as it is. Migrating copies every document, which is not something a
  process should start doing because it booted, so it happens only inside the
  explicit admin action (`POST /admin/search/reanalyse`). Being a one-time step
  after an upgrade, it is offered as a dashboard migration notice — the same
  shape as the version backfill — shown while the analysis is out of date and
  gone once it is done.
- **The swap is atomic.** A single failed document in `_reindex` discards the
  new index and leaves the live one untouched. On success, `updateAliases`
  removes and adds in one request, so there is no moment where a search returns
  nothing. On a pre-alias deployment the index holding the name the alias needs
  is dropped by `remove_index` inside that same action list, so the first
  migration is atomic too.
- **Only the analysis is compared.** Mapping drift — a changed type or analyzer
  on a field that already exists — does not show up here. The repair is the
  same rebuild, so the comparison can widen when it needs to.
- **Writes during the copy are lost, so the job repairs the index before it
  ends.** An update that reaches the alias after `_reindex` starts is not in the
  new index, and two kinds of loss are more than staleness.

  - A dataset made private stays public: visibility is decided by the indexed
    `private` field, and the API does not re-check a search result against the
    database.
  - A deleted resource keeps its content: content is a child of the **package**,
    not of the resource, so chunks of a resource that is gone are still reached
    through a package that is not.
  - Content another worker indexed during the copy is lost, and the row still
    says it is indexed, so no ordinary run writes it again. Where that write
    was a replacement, the text it replaced comes back with the copy. Workers
    scale out, so this is not a corner case.

  Both are repaired inside this job rather than one queued behind it. A queued
  repair leaves the index lying for as long as the backlog lasts, and forever if
  that message reaches the dead-letter queue. The job rebuilds the metadata from
  the database (clearing before it writes, so deletions land) and drops content
  indexed for resources the database no longer has, and the message is not
  acknowledged until both are done. A redelivered message finds the analysis
  already current, skips the copy, and repeats only the repair. **What to
  repair is remembered by the index, not by the job**: the copy's start is
  written into the new index's `_meta` and stamped done when the repair
  finishes. A job is a queue message that may be delivered again to a process
  that knows nothing of the first attempt; the index is what survives. A
  resource whose Index step finished while the copy ran has its stale chunks
  **deleted there and then** before its `contentIndexed` is retracted and it is
  re-run from storage, so nothing is fetched — leaving the deletion to the
  queued run would keep the replaced text searchable for as long as the backlog
  lasts. Those rebuilds are separate jobs and may still be running when the
  repair is marked done; one that fails leaves content **missing, not exposed**,
  and says where it went: the run records `error` on the resource's pipeline
  row, which the admin jobs screen lists with a re-run beside it, and
  `contentIndexed` stays false until a run writes it — so the gap is in the
  database and not only in the queue. Reading the dead-letter queue is not part
  of this; the window is
  the copy, so this is a handful of resources and over-selecting one costs a
  rebuild nobody needed.

  Where the judgement itself cannot be had — an unreachable cluster — the
  screen may say nothing but the **job fails**. Reading "cannot tell" as
  "already current" acknowledges a message whose work never happened.

  Re-checking visibility against the database on the search path would also
  close this, at a database round trip per search; that is not the trade made
  here.

- **The message is held for as long as the handler runs.** A copy takes
  minutes on a large catalogue, which is longer than the queue's visibility
  timeout; left alone, the same message goes to a second worker and eventually
  to the dead-letter queue while the work is still running. The queue adapter
  extends the visibility while a handler runs, capped, so a worker that stops
  answering still loses its claim.
- **Every attempt copies into a name of its own.** Two attempts that derive the
  same destination have to agree about who owns it, and every way of asking —
  a marker, a lease, a running task — leaves a window in which one deletes what
  the other is filling. Different names retire the question: each attempt fills
  its own index, and the alias swap decides which becomes the catalogue.
- **The swap is conditional.** `remove` carries `must_exist`. Without it, a
  second attempt removing an alias that has already moved removes **nothing**,
  its `add` still runs, and the name ends up over two indexes — which takes no
  writes at all ("no write index is defined"), so indexing stops silently. With
  it the second attempt is refused and the whole action list is rejected.
- **Once the alias has moved, nothing deletes the new index.** What remains
  after the swap is housekeeping — deleting the index that was replaced — and
  failing at it leaves a stray index, not an outage; the next run's sweep
  collects it. A swap whose answer was lost may still be applied, so cleaning
  up "our own" destination would delete the index the alias is about to point
  at. Reading the alias back does **not** settle it either: asked a moment
  before the swap lands it answers with the old index, and the destination
  deleted on the strength of that answer is the one the swap moves to. The
  destination may be deleted only where the swap was never requested, or where
  the cluster refused it outright with a 4xx. A timeout, a dropped connection
  or a 5xx leaves it for the sweep.
- **An abandoned index is recognised by age alone.** With a name per attempt,
  nothing reuses the destination of a run that died. Anything older than the
  copy's deadline belongs to an attempt that is over; anything younger may be in
  flight.
- **Batches of 10.** Measured 2026-09-17: at 50 documents a batch — 15MB of
  500KB chunks in flight — copying a 285MB index reaches 80% heap and 1.6gb
  against the 1.8gb parent circuit breaker, and a search running alongside it is
  rejected. `t3.small.search`, the smallest deployment size, has half that heap.

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
