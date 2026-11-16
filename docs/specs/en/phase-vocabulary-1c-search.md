# Phase Vocabulary-1c: Search filters by vocabulary — Implementation Spec

> **Goal**: let people find datasets by the vocabulary of their tables' columns (ADR-073). The
> search screen gets two filters, "Area" and "Column meaning". **The vocabulary feature ships as
> experimental.** ADR-073 is the source of truth for design decisions.
>
> The Japanese version (`docs/specs/jp/phase-vocabulary-1c-search.md`) is authoritative; this is
> a translation for reference.

## 1. Premises

- **ADR-073 steps 1a and 1b are implemented.** Profile columns carry `vocabulary` (concept,
  scheme, representation, share, matches per level, period), shown on the public page and in the
  dashboard's "Table settings" tab
- **The vocabulary only runs where a site enables a pack** (setting `vocabulary-packs`, empty by
  default). On a site with no pack enabled, this phase's filters do not appear
- **The search documents carry no vocabulary.** A resource document has column names only
  (`columns`, a text field for full-text search); the profile's roles, values and vocabulary are
  not indexed
- **A profile change alone does not rewrite the search documents.** The pending mark
  (`resource.doc_sync_due_at`) is set only when Interpret changes the column names (`movePointers`
  in `step-tracker.ts`). A vocabulary re-read (`rebuildOnly`) is the same
- **The precedent for rolling resource values up to datasets is the format filter.** OpenSearch
  uses `children{resource}` → `terms` → `parent{resource}`; PostgreSQL uses a join and
  `COUNT(DISTINCT package.id)`

### 1.1 Decisions

| #   | Topic                   | Decision                                                                                                                         |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which filters           | **Two: "Area" and "Column meaning".** Both come from the same index fields                                                       |
| 2   | Nationwide tables       | **A column covering 40 or more top-level areas (prefectures) is "nationwide", and is not counted per prefecture** (§4.2)         |
| 3   | Which vocabulary counts | **Decided vocabulary only** (no `alternatives`). A column left between candidates is not counted                                 |
| 4   | Experimental            | The filter headings carry an "Experimental" mark; the API description says the shape may change (§8)                             |
| 5   | CKAN-compatible API     | **Not in this phase.** `fq` support follows (§9)                                                                                 |
| 6   | Dataset metadata        | **Not in this phase.** Giving datasets a covered area is considered separately; once there, it joins the same "Area" filter (§9) |

## 2. Terms

| Term           | Meaning                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Area           | An entry of the vocabulary's scheme (the Local Government Code today; the Standard Area Code after ADR-073 §9)  |
| Top-level area | The top of an area's parents. A prefecture in the Japan pack                                                    |
| Matched areas  | The areas a decided column's values matched (codes for a code column; areas names resolve to for a name column) |
| Nationwide     | A column whose matched areas have 40 or more top-level areas                                                    |

## 3. Record the matched areas on the profile (worker)

Today the profile keeps matches per level (`levels`) and the period (`periods`), not the matched
areas themselves. The index needs them.

- Add **`places: string[]`** (matched area codes, unique and sorted) and **`roots: string[]`**
  (their top-level area codes) to `columnVocabularySchema`. Both optional (old profiles lack them)
- Add **`kind: 'code' | 'name'`** (the representation's kind) as well. The index's
  `vocab_meanings` (§4.1) splits by kind, but the profile holds only the representation's ID
  (`code6`, `name`, …), which differs by pack. The PostgreSQL fallback (§4.4) builds from the
  profile's jsonb alone, so the kind must be on the profile
- Every code is held as the pack's canonical code (6 digits with the check digit in the Japan
  pack, `130001`); the index and the API use the same form (§4.1, §5.1)
- **`places` is built from the whole column.** The judgement may use a sample
  (`INFERENCE_RULES.corroboration.sampleRows`, 10,000 rows); recording areas from the sample would
  drop areas the sample missed, and the dataset would be missing from those areas' filters
  - A code column: from the whole column's distinct values (read in the judgement's first pass)
  - A name column: unique names from the whole column's distinct values. Where shared names were
    decided by a neighbouring code column, read the (code, name) pairs of just those names from all
    rows after the judgement. Their number is bounded by the shared names and the code column's
    distinct values
- Only for decided vocabulary; not for a column left between candidates
- Size bound: `places` is capped by `INFERENCE_RULES.maxValues` (5,000). A nationwide table has
  about 1,900, some 12KB of 6-character codes, which fits `resource_pipeline.profile` (jsonb)
- Top-level areas come from the core's `ancestorsOf` (no country-specific rule, ADR-073 §8). An
  area that is itself top-level (a prefecture column) is its own top
- **Raise the rules' version (`RULES_VERSION`)**, so existing tables are re-read and gain `places`

## 4. Search index

### 4.1 Fields added to the resource document

| Field            | Type      | Content                                                                                                                                                                     |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocab_meanings` | keyword[] | `<concept>:<kind>`, e.g. `admin-area:code`, `admin-area:name`. For the "Column meaning" filter                                                                              |
| `area_roots`     | keyword[] | Top-level area codes. A nationwide column contributes only `*` (nationwide). The first level of "Area"                                                                      |
| `area_places`    | keyword[] | Matched area codes other than the top-level areas themselves (only the areas below them). A nationwide column contributes none. The second level of "Area" (municipalities) |

- A resource with several vocabulary columns takes the union
- Top-level areas go only into `area_roots`. A prefecture column (one holding only Tokyo, say) puts
  `130001` into `area_roots` and nothing into `area_places`, so the second level never lists "Tokyo"
  beside its municipalities and `area_place` cannot name a top-level area
- Field names start with `vocab_` / `area_` so they do not collide with existing fields
- **The mapping is additive**, so it goes into `ADDITIVE_PROPERTIES` (`ensureWritableIndex` runs
  `putMapping` before the first write). Existing documents fill in through the re-read in §5 or
  "Rebuild search index"

### 4.2 Nationwide

- A column with 40 or more top-level areas (covering most of the 47 prefectures) is nationwide:
  `area_roots` gets only `*`, and `area_places` gets nothing
- Why: counted per prefecture, nationwide tables would appear under every prefecture filter and
  bury the data specific to that area. Choosing "Nationwide" finds them
- Trade-off: someone filtering by "Tokyo" does not see a nationwide table that includes Tokyo's
  rows. The "Nationwide" count on the results screen points them to it (§6)
- The threshold (40) is a constant on the indexing side (`NATIONWIDE_ROOTS`), not in
  `INFERENCE_RULES`. The number of top-level areas varies by country, so it may become per pack
  (one constant is enough while only Japan exists)

### 4.3 Rewriting documents

- **Set the resource's pending mark when the vocabulary-derived fields change.** Extend
  `movePointers`' condition "the column names changed" with "the columns' vocabulary changed". What
  is compared is the list of the profile's columns' `vocabulary` (jsonb) itself (`profileVocabularies`,
  shaped like `schemaColumnNames` for the names). A change of share alone sets it too, costing one
  more sync, and the comparison stays inside the one SQL statement
- Discarding derivatives on a purge or a revert (`discardDerivedArtifacts`) clears the profile as
  well, so it sets the mark in the same statement
- Version adoption (`resource-version-service.ts`) needs no such condition: it rewrites the column
  names but never touches the profile, so the vocabulary fields do not change
- The vocabulary re-read (`refresh-vocabulary-profiles` → `rebuildOnly`) reaches the search
  documents through this condition

### 4.4 The PostgreSQL fallback

- No index table. Join `resource_pipeline.profile` and read the jsonb
- Filters: `EXISTS` (join the resource and look at each element's `vocabulary` under
  `profile -> 'columns'`). One function builds the same values as §4.1 in SQL, shared by filters
  and counts
- Counts: `COUNT(DISTINCT package.id)`, as the format filter does
- The fallback serves small sites, so the cost of expanding jsonb is accepted. If slow, add a
  generated column or an index later

## 5. Search API

### 5.1 Filter parameters

| Parameter    | Example                   | Meaning                                                  |
| ------------ | ------------------------- | -------------------------------------------------------- |
| `area`       | `area=13`, `area=*`       | Filter by top-level area (prefecture); `*` is nationwide |
| `area_place` | `area_place=131016`       | Filter by matched area (municipality)                    |
| `meaning`    | `meaning=admin-area:code` | Filter by column meaning                                 |

- Each may repeat. Values of one parameter combine with **OR** (unlike the format filter, since
  "Tokyo or Kanagawa" is the natural choice for areas); different parameters combine with **AND**
- `area` accepts a prefecture code in 2 or 6 digits (`13`, `130001`), normalised to the pack's
  canonical code (`130001`) before it is matched against the index's `area_roots` (the same form,
  §3). `area_place` likewise
- Draft listings (`my_org` and other DB-search paths) refuse them, like the other filters

### 5.2 Counts (facets)

- With `include_facets=true`, the response adds `areas` (per top-level area, `*` included) and
  `meanings`
- The second level of "Area" (municipalities) is returned only when `area` is given
  (`area_places`, limited to areas under the chosen prefectures), so the ~1,900 nationwide
  entries are not returned every time
- Areas chosen in `area_place` are always returned as buckets, with or without `area`, so a chosen
  municipality never vanishes from the screen while the results stay filtered by it (a second
  guard beside how §6 removes it)
- The API labels the buckets ("Tokyo", "Chiyoda", "Administrative area code"). Area names come
  from the enabled packs' registry (`registryFor` in `@kukan/vocabulary`); a code no pack knows is
  returned as is
- Hybrid search's `mergeFacets` and `PackageService.enrichFacets` are hard-coded to the five
  existing filters; add the two new ones. `enrichFacets`' "list zero-count values too" does not
  apply to areas (47 prefectures at zero are not listed)

## 6. Screen

```
┌ Filters ───────────────────────┐
│ 🗾 Area  Experimental          │
│  ☐ Nationwide (37)             │
│  ☐ Tokyo (128)                 │
│  ☐ Osaka (64)                  │
│  Show more…                    │
│   └ with Tokyo chosen:         │
│      ☐ Chiyoda (12)            │
│      ☐ Chuo (9) …              │
│                                │
│ 🔗 Column meaning  Experimental│
│  ☐ Administrative area code (52) │
│  ☐ Administrative area name (88) │
│ 🏢 Organization …              │
└────────────────────────────────┘
```

- Add two `FilterSection`s to `dataset-filters.tsx`. A filter with no counts is not shown (on a
  site with no pack enabled, neither is)
- The heading carries a small "Experimental" mark (`Badge variant="outline"`), explained in a title
- Add `area` / `area_place` / `meaning` to `dataset-list.tsx`'s `filterParams` (what filter links
  carry) and to the SSR `filterKeys`
- "Area" shows the municipalities' counts under a prefecture once it is chosen (§5.2)
- The link that removes a prefecture removes the `area_place` values chosen under it too. Removing
  the prefecture alone would leave only the municipality condition in the URL, and the results
  filtered by it
- **The vocabulary badge on each search result moves to step 2** (§9): the search response is per
  dataset, with no path yet that returns its resources' vocabulary

## 7. Tests

- Worker: recording `places` / `roots` for a nationwide table (40+ top-level areas), a prefecture
  column, a name column (including areas resolved from shared names by codes), and a column left
  between candidates (not recorded); recording `kind`; in a table longer than the sample, areas the
  sample missed still in `places` (including a name column whose shared names were decided by codes)
- Index building: the three fields of §4.1, the union, nationwide handling
- Pending mark: set when only the vocabulary changes, not set when it does not
- Search adapters (OpenSearch and PostgreSQL): `area` / `area_place` / `meaning` filters and
  counts; OR within a parameter, AND across parameters
- API: bucket labels, the second level only with `area`, codes no pack knows; `area=13` and
  `area=130001` giving the same result
- Screen: hidden at zero counts, the experimental mark, municipalities after choosing a
  prefecture, links carrying the parameters, removing a prefecture removing the municipalities
  chosen under it
- API: a request without `area` still returns the areas chosen in `area_place` as buckets
- Add the new PostgreSQL SQL to the sql-shape integration test

## 8. Marking it experimental

- Screen: an "Experimental" mark on the filter headings (§6), and the same mark on the dashboard's
  "Column vocabulary" card
- API: the new parameters' and counts' descriptions (OpenAPI) say "experimental; the shape may
  change"
- Release notes list it as an experimental feature
- ADR-073 stays "Proposed"

## 9. Follow-ups (outside this phase)

- A vocabulary badge on each search result ("Administrative area code · 62 municipalities of Tokyo")
- `fq` in the CKAN-compatible API (`area:13` and so on), and `facet.field`
- The filters in MCP's search tool
- Adding datasets' covered areas (considered separately, as metadata vocabulary) to the same "Area" filter
- After ADR-073 §9 (the Standard Area Code as master), whether to filter by groups such as
  counties and subprefectures
