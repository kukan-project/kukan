# ADR-062: Filter datasets by extras keys and values

## Status

**Accepted** — 2026-10-11 (proposed 2026-10-05)

Put dataset `extras` and resource `extras` into the search index so datasets can be filtered by a
key–value pair. The native API takes `extras_<key>=<value>` and `res_extras_<key>=<value>` as
query parameters; the CKAN-compatible API reads the same names as `fq` fields (extending ADR-060).
Values are compared by exact match.

## Context

### 1. Extras are returned but cannot be searched

Datasets and resources both have `extras`, and reads return them (ADR-060 made resource extras
writable). The search index, however, does not hold them.

- A resource's search document is built from `resourceDocColumns`: name, description, format,
  section and summary only
- A dataset's search document (`DatasetDoc`) has no extras field either
- The PostgreSQL fallback search does not look at extras

A site that classifies its datasets through extras ("updated monthly", "per municipality") cannot
search by that classification. Typing the value as a keyword does not match either.

### 2. How CKAN handles it

In CKAN 2.12's index (`ckan/lib/search/index.py`, `ckan/config/solr/schema.xml`):

- **Dataset extras** are always indexed as dynamic `extras_<key>` fields. Characters outside
  `[0-9A-Za-z_-]` are stripped from the key first. The field type is `text` (whitespace
  tokenised, lower-cased, English-stemmed), so matching is not exact. Values are also copied into
  the full-text `text` field
- **Resource extras** are indexed as `res_extras_<key>` only for the keys listed in the
  `ckan.extra_resource_fields` setting (empty by default). Each dataset's resources are
  flattened into one multi-valued field
- Callers filter with `fq=extras_spatial_unit:...`

### 3. Extras values are not always strings

KUKAN's `extras` is `z.record(z.string(), z.unknown())`; a value may be any JSON. Keys are
unconstrained too and may contain Japanese, `.` or `:`.

## Options considered

### Query parameter shape

#### A) Repeat `extras=key:value`

A fixed parameter name, easy to declare. But a key containing `:` leaves the split point
undecided, and an escaping rule would add a second layer on top of URL encoding.

#### B) One JSON parameter (`extras={"k":"v"}`)

Unambiguous, but unreadable as a URL and awkward to write by hand. No CKAN counterpart.

#### C) `extras[key]=value` (bracket notation)

A convention of some frameworks; Hono does not parse it. A key containing `]` is ambiguous. No
CKAN counterpart.

#### D) `extras_<key>=<value>` / `res_extras_<key>=<value>` — adopted

The key goes into the parameter name, so URL encoding alone can express any key. The native API's
filters already use CKAN's index field names (`res_format`, `license_id`), and these sit beside
them. The CKAN-compatible `fq` can read the same names as fields, so one filter has two entrances.

### How OpenSearch holds them

#### a) A dynamic field per key

Every new key adds a mapping; a site's input alone can hit the field limit.

#### b) The `flat_object` type

No mapping growth, but keys are treated as dotted paths, so a key containing `.` cannot be told
apart from a nested path.

#### c) A multi-valued keyword field of pairs encoded as one string — adopted

Encode each pair as `JSON.stringify([key, value])` and store it in a multi-valued keyword field.
A `term` query matches exactly. Being a JSON array, the encoding stays unambiguous whatever
characters the key or value contain. The mapping is one fixed field.

## Decision

### 1. Query parameters

Add to `GET /api/v1/packages`:

| Parameter                  | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `extras_<key>=<value>`     | The dataset's extras have key `<key>` with value `<value>`   |
| `res_extras_<key>=<value>` | Some resource's extras have key `<key>` with value `<value>` |

- `<key>` is URL-encoded. KUKAN does not strip characters from it (unlike CKAN)
- All conditions are joined by AND, including a repeated parameter (as `tags` and `res_format`
  are). No OR is offered
- Each `res_extras_*` condition means "some resource satisfies it"; two conditions need not be met
  by the same resource. This matches CKAN's flattened field and KUKAN's `res_format`
- An empty key (`extras_=`) is refused with 400
- At most 20 extras conditions per request, dataset and resource together; more are refused
  with 400
- The direct-DB `state=draft` path refuses them, as it does the other index-backed filters

### 2. Comparing values

Values match exactly: no case folding, no trimming, no Unicode normalisation.

What goes into the index:

| Extras value   | Indexed as                                     |
| -------------- | ---------------------------------------------- |
| String         | As is                                          |
| Number         | Decimal without an exponent (`5`, `0.0000001`) |
| Boolean        | `true` / `false`                               |
| Array          | Each scalar element (one pair per element)     |
| Object, `null` | Not indexed                                    |

`extras_n=5` matches both the number `5` and the string `"5"`. Query parameters carry no type, so
the index side aligns them. Numbers are written without an exponent because that is how PostgreSQL
prints a jsonb number; the spelling it was written in (`1e-7`) does not survive in jsonb. The
OpenSearch side follows it so the two backends spell numbers alike.

### 3. Index

- **OpenSearch**: add `extras_pairs` to the dataset document and to the resource child documents
  (ADR-025) as multi-valued keyword fields, holding the pairs built by the rule in §2
  (`JSON.stringify([key, value])`). An `extras_<key>` condition is a `term`; each
  `res_extras_<key>` condition is its own `has_child`
- A pair longer than 256 bytes is stored as its SHA-256 (`sha256:<hex>`), and queries build pairs
  by the same rule. A keyword term is capped at 32,766 bytes; past it the whole document is
  refused, and even a rename stops reaching the search. Extras values have no length limit (a
  harvested GeoJSON footprint, say). A pair starts with `[`, so it cannot be taken for a hash
- **PostgreSQL fallback**: no index; compare `package.extras` and `resource.extras` with jsonb
  operators directly. One predicate implementing the §2 rule (numbers equal to their string form,
  array elements) serves both conditions. Whether to keep an array of pair strings under a GIN
  index is decided when search moves to PostgreSQL (ADR-061 stage 2)
- The legacy health-check keys (`LEGACY_HEALTH_EXTRAS_KEYS`) stay out of the index, as they stay
  out of reads
- Private and draft datasets are handled by the existing visibility filters

The index shape changes, so a full reindex is needed after release.

### 4. CKAN-compatible `fq`

Read `extras_<key>` and `res_extras_<key>` as `fq` fields and pass them to the §1 filter.

- Values are compared by the exact match of §2, not by CKAN's `text`-type token matching. The
  result can be narrower than CKAN's, but extras values are mostly classification codes and fixed
  terms, and reproducing token matching is not worth its cost. The difference goes into the
  compatible API's documentation
- `fq` splits field from value at `:`, so a key containing `:` or whitespace cannot be written in
  `fq`; use the native API
- Syntax Solr would not read literally is refused with 409. Outside quotes: wildcards (`*`, `?`),
  ranges (`[`, `{`), boosts (`^`), fuzziness (`~`), `:`, parentheses, `"`, and a leading `!`, `/`,
  `+` or `-`. Backslash escapes inside or outside quotes. To look for such a value, quote it.
  Compared as written, they would answer a different question without a word (asking whether a key
  exists, `extras_<key>:*`, is open question 3)
- Two different values ANDed on the same `extras_<key>` are not short-circuited to zero hits the
  way `organization` and the like are: an array value can match both
- Resource extras are indexed for **every key**, unlike CKAN's default, where only the keys in
  `ckan.extra_resource_fields` can be searched. What KUKAN can find is a superset of CKAN's
- CKAN also indexes extras under the bare key (`spatial_unit:...`); KUKAN does not read that. It is
  refused with 409 as an unknown field (ADR-060 §3)

## Consequences

- Datasets can be filtered through the API by the classifications a site keeps in extras
- CKAN harvesters and ckanapi can use `fq=extras_*`
- Dataset and resource search documents grow. Extras volume varies by site, so check the index
  size after reindexing
- Keeping search documents in sync after an extras edit needs no new mechanism. Datasets and
  resources both set the pending-sync flag (`doc_sync_due_at`) on every update, so once the
  document builders include extras the next sync carries them

## Open items

1. **Should keyword search (`q`) match extras values?** CKAN copies values into its full-text
   field. If we do, include values only, not keys. Measure the effect on ranking with the search
   golden set first; best decided together with ADR-061's BM25 field design
2. **Facets.** Whether to return "how many datasets have each value of this key". Making the caller
   name the key (`facet.field=extras_<key>`) is the candidate shape
3. **Filtering by key presence alone** (`extras_<key>=*`). Not offered now: it cannot be told apart
   from a literal `*` value
4. **The web search page and MCP `search_datasets`.** Which keys to expose differs per site, so it
   would be chosen in site settings
5. **Value normalisation.** If misses from full-width/half-width variants are reported, consider
   applying the same normalisation to both the index and the query

## Related ADRs

- ADR-013: Separating search from DB filtering
- ADR-025: OpenSearch parent-child index (resource child documents)
- ADR-060: Bring the CKAN-compatible API's reads in line with CKAN 2.12 (how `fq` is read; this ADR
  extends it)
- ADR-061: Move search to PostgreSQL (the stage that settles how PostgreSQL holds the index)
