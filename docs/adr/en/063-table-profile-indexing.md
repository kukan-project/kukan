# ADR-063: Index tabular files by a "table profile", not by their contents

## Status

**Proposed — put it into today's OpenSearch first, and confirm after checking table searches on the golden set** — 2026-10-05

Stage 1 (build and store the profile; the index does not change) is implemented — 2026-10-06

Stage 2 (put it into today's OpenSearch) is implemented. Overriding roles by hand and showing "matched a
column name" come later — 2026-10-06

JSON and GeoJSON ride the same mechanism, as tables of records (§Decision 10) — 2026-10-11

The text index for CSV/TSV moves from chunks of the file's contents to a **table profile**. The profile
consists of the column names, the values of name and categorical columns, the ranges of numeric and date
columns, the row and column counts, and the text of free-text columns (with context from the same row).
Numeric cells and repeated values are not indexed.

To do so, each column gets a "role" separate from its type (numeric, name, categorical, identifier, free
text and so on), decided by rules and kept beside the column schema. Roles are shown in the field list and
through MCP, and can be overridden by people.

It goes into today's OpenSearch without waiting for ADR-061 (moving search to PostgreSQL). When search
moves to PostgreSQL, the same profile is used as it is. XLSX joins the same mechanism once ADR-057 is in.

This ADR extends ADR-032 Part A (persisting the column schema).

## Context

### 1. How tables are handled today

Tabular files are indexed like document text: the file's contents are cut into 500KB chunks
(`indexTextStream` in `apps/worker/src/pipeline/steps/index-content.ts`, ADR-021).

Measuring the local development index found that **71%** of the text bytes were tabular
(279 resources, about 295MB), and **67%** of the term dictionary was words made of digits only.

### 2. What is wrong with it

- **Numeric cells are no clue for search**, yet they make up most of the index
- **The same value repeats thousands of times.** If "青森市" appears in 10,000 rows, all that matters is
  that the table contains "青森市"
- **Column names carry no weight.** A column name appears once in the first row, so BM25 buries it under
  the values, while it is the most informative part when looking for a table
- **Fragments of a table are no context for RAG.** A table cut at 500KB or 1,500 characters does not say
  which column a value belongs to. ADR-061 does not make tables into passages either

### 3. What already exists

- Column type inference (ADR-029) and the persisted column schema (ADR-032 Part A): per column, the name,
  type, number of missing values, number of distinct values, whether all values are distinct, and numeric
  minimum and maximum, plus the table's row count
- The preview Parquet written by Interpret, and DuckDB in the worker's child process (ADR-059)
- Row contents can be read with `query_resource` (ADR-032), and the table seen in the preview (ADR-048)

## Options considered

### A) Keep indexing the whole file

The problems in §2 remain. Rejected.

### B) Index column names only

The lightest. But a table cannot be found by its values, such as "a table that lists 八戸市". Rejected.

### C) Turn every row into a sentence and index it

Each row becomes "column: value / …" and every row a passage. Numeric rows are no clue even as sentences,
and tables with many rows make the index huge. Adopted only for free-text columns (part of D).

### D) Index a table profile — adopted (proposed)

Column names, the values of categorical columns and ranges, with only free-text columns indexed as text
with the row's context. It drops the numbers and repetitions that make up most of the index, while tables
can still be found by column names and values.

## Decision (proposed)

### 1. Decide each column's role by rules

Each column gets a "role", separate from its type (ADR-029). The role is decided by fixed rules, not by AI:
the same input always gives the same result, and it works without AI. A wrong role only changes whether a
search finds the table; no data is damaged. Where the rules miss, people override the role (Decision §5).

| Role              | Test (applied top to bottom)                                                                                                                                                                                                                                                                                                | Indexing                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Numeric / date    | Inferred as numeric, date or boolean, or 90% or more of values look like dates (`2026/5/12`, `令和6年4月`)                                                                                                                                                                                                                  | Not words; ranges are kept                  |
| Numeric (as text) | 90% or more of values look like numbers, including commas, brackets, symbols such as `-` `▲` `…`, and units                                                                                                                                                                                                                 | Not words                                   |
| Identifier        | 80% or more look like URLs, phone numbers or postal codes; or letters, digits and symbols only, with digits, nearly all values distinct; or a column name such as "コード", "番号", "ID"; or half the characters or more are digits with at least half the values distinct (coordinates, house numbers, amounts with units) | Not words                                   |
| Free text         | Has punctuation or the shape of a sentence (a run of hiragana, or six or more words), and is long (20 characters on average) or nearly all distinct; or a column name such as "備考", "説明", "Remarks"                                                                                                                     | Indexed as text with the row's context (§3) |
| Name              | In any language, at least half of the values distinct, 30 or more distinct values (facilities, projects, neighbourhoods, addresses)                                                                                                                                                                                         | A list of values (§2)                       |
| Categorical       | Any other string                                                                                                                                                                                                                                                                                                            | A list of values (§2)                       |

The clues are counted once per column by DuckDB in Interpret: value length, the share of character kinds
(digits, letters, kana, kanji), punctuation, the share matching a shape (number, date, URL, phone number),
the ratio of distinct values to rows, and the column name. The thresholds are starting values, tuned on
real data and the golden set.

In statistical tables, numeric columns routinely mix in "-", "…", "（8）" and "10,000", and type inference
leaves them as strings. In the local trial a third of the columns inferred as strings were such numbers
(Trial). Without this role, categorical and identifier columns fill up with numbers.

### 2. What the profile holds

- **Column names.** All columns, weighted highest
- **The values of name and categorical columns.** Every value, most frequent first, with no cap, each
  value once. Values are prefixed with the column name: "市区町村名: 青森市、弘前市、八戸市、…". Name
  columns with more than 1,000 values exist, such as projects (1,130) and neighbourhoods (1,171), and a cap
  would leave the tables holding the values it cut off unfindable by them. Keeping each value once makes the
  list smaller than the file
  - Every value goes into the artifact (Decision §4), and the index is built from it. The database keeps
    only the 30 most frequent values of each column, for display and agents
- **Ranges of numeric and date columns** (the existing minimum and maximum) and the row and column counts.
  For now they are for display and AI material, not search terms

### 3. Free-text columns are indexed as text, with the row's context

- Each row becomes "categorical column: value / … / free-text column: value". Up to three categorical
  columns are added, those with the fewest distinct values first
- Identical sentences are indexed once
- Each sentence keeps its row number, so a citation can say which row
- The sentences are indexed as text (500KB chunks today, passages after ADR-061)
- The amount of sentences per table is capped (starting at 500KB). What exceeds the cap is not indexed, and
  the excess is recorded, so the profile does not grow with the file

This is for natural-language text inside a table, such as a remarks column.

### 4. Built in Interpret and stored beside the column schema

- After Interpret writes the preview Parquet, DuckDB in the same child process (ADR-059) counts the clues
  and value frequencies per column. Types are inferred by then, and columns can be read one by one, which
  is lighter than parsing the CSV again
- When the rules change, only the classification is rerun on the existing Parquet, without redoing
  Interpret. When a person overrides a role, nothing is reclassified: the profile is rebuilt and the index
  updated (Decision §5)
- The current version's profile goes into the `profile` column of `resource_pipeline`, apart from the
  column schema (`resource_pipeline.metadata.schema`), with each column's entry at the same position as in
  the schema. The database is the source of truth
  - `role`: the role decided by the rules (Decision §1)
  - the reason ("92% of values look like numbers", "column name contains コード" and so on)
  - the 30 most frequent values of name and categorical columns
  - the artifact's key, how many sentences the cap left out, and why there is no profile when one could not
    be made
- It is kept out of the column schema for two reasons
  - The column schema is frozen onto each version as `resource_version.schema`. That record says how the
    version was read (ADR-046), and roles do not change the reading. Rule changes would rewrite past
    versions' records, and only the current version is indexed, so there is no reason to keep roles per
    version
  - `metadata` is polled by the processing-status view and read on every query and OData page. Value lists
    there would ride along on every one of those reads. Only the field list and `get_resource_schema` read
    `profile`
- MCP's `get_resource_schema` also returns roles and value lists, so AI composing SQL knows which columns
  can be aggregated and how values are spelled
- The free-text sentences and every value of the name and categorical columns are stored as a storage
  artifact and streamed when indexing
- Roles are not copied into the Parquet footer (`key_value_metadata`) for now. If there is demand for
  downloaded Parquet to carry them, a copy of the roles as decided at creation can be added

### 5. Show roles and let people override them

- The public field list shows the role next to the type. The field list reads the Parquet footer today, so
  roles come from the profile in the database
- The reason for a role ("92% of values are number-shaped" and the like) is shown in the dashboard, not on
  the public pages. A reader wants to know what a column is, not how the rules decided it; the reason is
  material for the person who checks the rules and decides whether to override them
- "Numeric (as text)" doubles as a data-quality note: the dashboard tells publishers why the column cannot
  be used as numbers (the values mixed in)
- Dataset editors can override a column's role in the dashboard. Overrides live in the confirmed layer
  with the primary key and confirmed types (`resource.column_settings`, Versioning-ii spec §6.1–6.2) and
  take precedence over the inferred role. Recomputing the inference does not touch them, and they apply to
  later versions as they are. The screen is the same as for primary keys and confirmed types: select
  several columns and apply them at once
- Overriding a role does not create a version, though. A confirmed type changes how the bytes are read, so
  it is an input to the version gate (same spec §6.5); a role does not change the reading, only the index
  and the display. An override rebuilds the profile and updates the index right away
- Flags editors set when judging personal data (Decision §6) live in the same confirmed layer

### 6. Share the clues with personal-data detection

The per-column clues (shares matching a shape, column names) also feed ADR-006's `PiiScanner`, counted in
the same pass.

- Columns that look like personal data (names of people, dates of birth, personal phone numbers or email
  addresses and so on) are kept out of the profile index. Otherwise people's names would become searchable
  as a name column
- Detection has different needs from search classification, though. A single row matters, so not missing
  one comes first. My Number and card numbers are checked with their check digits. A facility's phone
  number or address is public information, so the decision uses column names and combinations of columns,
  and the result is a warning to editors rather than a block on publishing. Suspected personal data is not
  shown on public pages
- The design of this detection (rules and AI, warnings, review before publishing) is a separate ADR

### 7. How it goes into today's OpenSearch

- **Column names** go into a new `columns` field on resource documents, added to the resource leg's
  `cross_fields` with a starting weight of 2 (as `description`), tuned by evaluation. This only adds to the
  mapping, so the index need not be rebuilt
- **Categorical values and free-text sentences** replace the file's contents in the table's text chunks
  (the content children). The artifact (Decision §4) is read and rebuilt into text: "column: value, value,
  …" per column, and one sentence per line for free text. The chunk documents keep today's shape (text and
  chunk number)
- **The artifact's row numbers and counts are not used in OpenSearch.** They are dropped when it is rebuilt
  into text
  - Counts: weighting words differently within one text field is hard with standard features. If
    evaluation shows values weigh too little, try putting the values with a large share of rows (the ones
    the table looks to be about) in a field of their own with a higher weight
  - Row numbers: not held in the index. One document per sentence would hold them, but the number of
    documents would grow with the rows. "Which row" and links to that row of the preview are made after a
    match, from the artifact or DuckDB
  - Both pay off on ADR-061's path (Decision §8). That is why the artifact keeps them: moving over needs no
    second interpretation
- The existing index is replaced by reprocessing tabular resources

### 8. Handing over to ADR-061

On PostgreSQL, column names become a metadata field, and the words of the categorical values and
free-text sentences go into the document's word set. Only free-text sentences become passages. Tables
are not made into passages (ADR-061).
Each free-text sentence is one passage with one row number, so a result can cite the row. Value counts can
weight the word set.

### 9. How results show it

The reason for a match is shown as "matched a column name" or "matched a value" (extending ADR-034's
`matchSource`). Opening the table preview (ADR-048) filtered to the matched value comes later.

### 10. JSON and GeoJSON ride the same mechanism, as tables of records

Among the text formats, JSON and GeoJSON are mostly repeated key names, coordinates and code values, and
swelled the index the way CSV contents did (locally, one registry JSON held a third of the content index).
Yet some JSON carries a description per record, and that text should be searchable. So **a JSON that reads
as a list of records is made a table in Interpret, by DuckDB's `read_json`, and goes out the same way a CSV
does (Parquet, column schema, profile).** What is indexed is decided by the column roles — there is no
exception for being JSON.

- **Three shapes read as a table.** A top-level array, one array under a single key (`{"dataset": [...]}`,
  which is nearly every JSON on public CKAN portals), and a GeoJSON FeatureCollection (a feature's
  `properties` is a row). Anything else — a configuration object, a nested document, an array of strings,
  a file that is not JSON — is recorded as `not-records`, and the content index is built from the text of
  the contents as before
- **A nested object's keys become columns named by their path joined with `_`** (`contact_phone`); a
  `.` is not allowed in an OData identifier (ADR-055). Arrays, and values of
  no one type, are kept as JSON text in one column. `unnest(recursive)` is not used: it collides on
  names such as `description` and `updateDate`
- **A Point's coordinates become two columns, `geometry_lon` and `geometry_lat`.** A place is something a
  query filters on. A line's or a polygon's coordinates stay out — they are most of the file's bytes, and
  a preview page or a feed page read by row group could not carry them. What is kept is the list of
  geometry types (`ResourceSchema.geometryTypes`); the count is the row count. Parquet itself holds
  arrays and nesting, but the column schema's six types, OData, the fields list and the profile know only
  scalars. A bbox or a representative point for lines and polygons comes later
- **A JSON that is one object has a cap of its own** (`MAX_JSON_OBJECT_SIZE`, 32MB). A FeatureCollection,
  or records under a key, is read whole by DuckDB before the array inside is taken out; a top-level array
  is read an element at a time, so the CSV's 100MB serves. Measured: a 26MB FeatureCollection of 13,000
  features read under the 512MB cap, a 76MB one of 79,000 failed at 768MB and read at 1GB. Past the cap,
  `too-large` is recorded and the index falls back to the text of the contents. The refusal is settled
  with an empty schema — the sweep checks only the 100MB cap, and would otherwise hand the version out
  every hour — so a raised cap is reached by reprocessing. Reading the properties without the
  coordinates comes later
- **Nesting has a cap too** (`MAX_JSON_DEPTH`, 64 levels). Counted in one pass before DuckDB reads the
  file; past it, `not-records` is recorded with an empty schema. A thousand levels cost DuckDB minutes and
  gigabytes, and deeper still it crashes, which is not settled — so the file is refused before it is read
- **Layer 2 and the primary key as for a CSV.** A version that made a table is loaded into layer 2
  (ADR-043) whatever its format, and a primary key can be chosen. The sweep's formats share
  `TABLE_SOURCE_FORMATS`, so they cannot drift from what the interpretation reads. A JSON array tends to
  be written out in a different order each time, so tracking changed rows by a key says more than
  replacing every row. A GeoJSON Feature's own `id` (RFC 7946 §3.2; optional, and few files carry it)
  becomes a column `id` only where present, suffixed where `properties` has one of the same name
- **The preview shows the table as one mode.** JSON toggles between "Table" and "JSON", GeoJSON between
  "Map", "Attributes" and "JSON"; the table is read from the Parquet. The fields list, `query_resource`
  (ADR-032) and OData (ADR-055) go by whether there is a schema, so a JSON table rides them as it is
- **The sentence cap stays** (§Decision 3, 500KB). A JSON with a long description per record loses most
  of its sentences to it (the local registry: 7,679 of 7,812 rows), but that is the treatment a CSV with a
  large remarks column gets. Moving the cap is §Decision 3's to do, for every format

TXT and MD are prose and keep the full-text index (19 of 20 TXT files on public CKAN portals were text
editions of municipal newsletters). HTML (script and style contents reach the index) and XML (records, but
nothing in DuckDB reads them) are separate issues.

## Stages

1. **Build and store the profile.** The index does not change. Check the size and how well real data is
   classified
   - Implemented: roles and their basis (Decision §1), the profile (Decision §4, `resource_pipeline.profile`),
     shown in the field list and by `get_resource_schema` (Decision §4, §5), and the profile artifact
     (Decision §3, §4)
   - Existing resources get them from "rebuild the preview and index" or "reprocess all resources". A plain
     reprocess reuses the derivatives when the content has not changed, so it does not
   - The artifact holds **every** value of the name and categorical columns, with no cap, and the free-text
     sentences (zstd-compressed NDJSON, under `previews/` with the preview's token, named by `profile.key`). The
     index is built from all of them; the values in the database (30 a column) are a head of them for
     display and agents. Each value carries how many rows hold it and the first of them; each
     sentence how many rows read it and the first. The counts are material for ranking (is the value what
     the table is about, or on one row by chance), the rows for citations and links into the preview.
     OpenSearch does not use them (Decision §7)
   - Moved to stage 2: overriding a role by hand (Decision §5). It has no effect until the profile is
     indexed
   - `GET /resources/:id/schema` returns each column's role beside the column schema (`columnRoles`), without
     the values; `get_resource_schema` returns those
2. **Put it into today's OpenSearch.** It passes if the golden set's overall does not drop (within noise)
   and table-finding queries do not drop. If there are too few table-finding queries, add them to the golden
   set first
   - Start by rebuilding the artifact into text for the chunks, without the row numbers and counts (Decision
     §7). If values turn out to weigh too little, try splitting them into fields by their share of rows
   - Implemented: `columns` on resource documents (weight 2), chunks rebuilt from the artifact, and a
     pending-sync flag that syncs the resource document again when its column names change. Value lines
     break every 120 characters, repeating the heading
   - What Interpret made no table of (too many columns, rows it would not read, not enough memory and so
     on), and tables whose profile failed, are indexed by the first 64KB of their contents. The headings
     and first rows help find the table; the rest is answer codes and numbers that search has no use for.
     Locally, one survey table of 978 columns took 22MB (15% of the table content) indexed whole
   - A content snippet keeps at most 60 characters before its first match (from the start of the match's
     line when that is near). OpenSearch's highlighter starts a fragment some 300 characters before the
     match, so on long lines of values joined by "、" the match fell outside the few lines a result card
     shows. This applies to all content, not only tables
   - Outcome: passed ("Stage 2 measurements" below). The golden set had no queries that find a table by a
     value, so 13 values that appear nowhere in the metadata were added as type `value`
   - Moved on: overriding a role by hand (Decision §5), showing "matched a column name" (Decision §9).
     Afterwards the reasons moved from the public pages to the dashboard
     (`GET /resources/:id/column-roles`), and `columnRoles` in `GET /resources/:id/schema` now returns the
     role alone
3. **Hand it over to ADR-061's PostgreSQL path** (Decision §8)

## Trial

The rules in Decision §1 were applied to the 285 CSV/TSV files (5,352 columns) in the local development
environment. The script is in `spike/adr-063/`.

| Role              | Columns | Examples                                                         |
| ----------------- | ------: | ---------------------------------------------------------------- |
| Numeric / date    |   1,805 | —                                                                |
| Numeric (as text) |   1,212 | Counts, amounts and ratios mixed with `-`, `10,000`, `（8）`     |
| Categorical       |   1,225 | Kinds (vegetables, fruit), markets (Toyosu, Adachi, Ota), yes/no |
| Name              |     260 | Facilities, projects, neighbourhoods, embassies, addresses       |
| Identifier        |     149 | Item numbers, URLs, phone numbers, postal codes                  |
| Free text         |     127 | Remarks, notes on opening hours, free answers in surveys         |
| Empty             |     574 | —                                                                |

This is after three rounds of fixing the rules: numbers and dates written as text, phone numbers (repeated
values, so "nearly all distinct" misses them), and long names (length alone cannot tell them from prose).

Remaining misses:

- In tables with multi-row headers, leftovers of the header ("合計" and so on) end up among the values. That
  is a header problem (ADR-046)
- Columns of short free answers ("なし", "わからない") can land in name. Their values are indexed either way
- The local environment includes test tables of random values. Checking on data close to production is part
  of stage 1

The stage 1 implementation was run again over the same 285 files. What changed:

- "Japanese" was dropped from the name rule, and "with digits" added to the identifier rule for distinct
  letters and digits. Treating one facility differently in Japanese and in English is not right, and
  one-word English names (such as `France`) fell into identifier, leaving their values out of the index.
  28 columns moved to name (27 from categorical, 1 from identifier): English name columns (`名称_英語`, the
  tourist map's `name`) and half-width katakana columns. Codes with digits stay identifiers
- The free-text rules leaned on Japanese too, so "six or more words" was added to the shape of a
  sentence, and English headings (`remarks`, `notes`, `description` and so on) to the heading hints. No
  column moved locally. Western punctuation (`.` or `,` before a space) was tried as well, but it made
  four English name columns free text, through abbreviations (`Sta. North exit`) and inverted names
  (`Crane, wattled`), and caught no real prose, so it is not used
- As English data, the rules were run over New York City's 311 requests and the restaurant inspections of
  New York City and Chicago (5,000 rows each). The prose columns (resolutions, violations) all came out as
  free text, and restaurant names and addresses as names. Two kinds of miss, both fixed
  - `cuisine_description` (cuisines) became free text through the English heading `description`. English
    heading hints now apply only to the whole heading
  - Coordinates (`POINT (-73.84 40.74)`) and house numbers became names. Values whose characters are
    half digits or more, with at least half the values distinct, are now identifiers. On the 285 local
    files this moved 127 columns to identifier, nearly all numbers mixed with units or marks (`1兆370億円`,
    a bus timetable's `05 36`, `4番35号`) whose values had been index terms. Amounts and times ought to be
    published as numbers, and leave the index as identifiers. In three columns of an election table with a
    broken multi-row header, candidates' names mixed into the vote counts go with them

- 132 time columns (DuckDB `TIME`) moved from empty to numeric / date. The trial tried to measure them as
  text, failed, and counted them as empty. A column that type inference made anything other than text is
  numeric / date by its type
- Dates ending at the month, such as "令和6年4月", now count as date-shaped. The trial's rule did not match
  them in full
- The shares of shapes (number, date, URL and so on) are counted over 50,000 evenly spaced rows in tables
  longer than that. On 400,000 rows with ten text columns, counting every row took Interpret from 1.9s to
  2.9s; 50,000 rows took it to 2.4s. Counts and distinct counts are taken over every row, because the rules
  use their ratio
- The profile in the database (roles, their basis and 30 values a column) came to 334KB for the largest
  table
- The artifacts (every value and the free-text sentences) came to 156MB uncompressed and 36.7MB with zstd,
  against 268MB of CSV. 29 tables had nothing to put in one (numbers and identifiers only); the largest was
  a test table of random values; 7 tables reached the sentence cap
- The artifacts are compressed with zstd. On 264MB of NDJSON shaped like an artifact, DuckDB (two threads)
  wrote gzip in 4.6s and zstd in 0.85s (0.4s uncompressed); a Node stream read gzip in 1.0s and zstd in
  0.6s; the sizes were 60.1MB and 53.6MB. Memory while reading grew by 14–19MB either way (zstd's window is
  2MB). On the 285 real files the sizes differed by 3% (gzip 37.8MB)

### Stage 2 measurements

In the local development environment (168 datasets, 493 resources), the index up to stage 1 was compared
with the stage 2 index after reprocessing every resource. Sizes were measured after a force merge to one
segment.

| Item                                 | Up to stage 1 | Stage 2        |
| ------------------------------------ | ------------- | -------------- |
| Whole index                          | 348.4MB       | 234.4MB (−33%) |
| Content chunks                       | 1,197         | 841            |
| Table content (chunks / text)        | 832 / 294.7MB | 476 / 115.5MB  |
| Resource documents with column names | —             | 272            |
| Golden set overall (nDCG@10)         | 51% → 88%     | 52% → 88%      |
| 13 value queries (R@10 / nDCG@10)    | 100% / 85%    | 100% / 85%     |

- The golden set is keyword → hybrid. Each type (synonym 95%, natural 89%, exact 100%, word 71%) is
  unchanged, and no query dropped. The value queries, which the file-content index already answered,
  rank the same on the profile
- Table content fell below 40%
- Comparing only how value lines break: 244.6MB at 4,096 bytes and 246.3MB at 120 characters, with
  identical results on every query. 120 characters puts the column name at the head of a snippet more
  often
- Cutting CSV made into no table to its first 64KB took 246.3MB to 234.4MB. The only change in the
  evaluation was one query's nDCG (39% → 43%)
- The weight of `columns` stays at 2, untuned. No golden-set query is found by column names alone, so its
  effect is not measured

## Consequences

- **CSV size limits.** The profile does not grow with the file, so the index no longer decides the size
  limit for CSV. Whether to raise the limits (100MB today for both ingest and Parquet) is decided by the
  ingest path and by the time and memory of Interpret and row-level diffs (ADR-043 layer 2), not by this
  ADR

- **Index size.** The tabular share (70% of the text locally) becomes one profile per table. Locally the
  whole index shrank by a third (Stage 2 measurements)
- **Searches that stop matching.** Values beyond the list's cap, and numeric or identifier cells, no longer
  find the table
- **Highlights.** Highlights in a table's text land on the profile sentences rather than the file's contents
- **MCP.** `get_resource_schema` returns column roles and value lists
- **Field list.** Roles come from the database, so the Parquet footer alone no longer completes the display

## Open issues

- Thresholds for deciding roles
- The weight of `columns`, tuned once the golden set has queries that find a table by its column names
- In CSV made into no table, values past the first 64KB are not indexed. Fix the interpretation so the
  profile picks them up (such as rows dropped over `- ` in numeric columns)
- Free text in English. The local data has no column of English prose, so whether six or more words and
  the headings are enough is unchecked. Western punctuation needs a use that does not catch names. English
  addresses of six words or more (`JOHN F KENNEDY AIRPORT, QUEENS (JAMAICA), NY, 11430`) cannot be told
  from sentences and come out as free text
- Finding a table by a code (postal codes, municipality codes and so on): index some identifier values, or
  make up with a column search in DuckDB
- CSV without a Parquet (beyond the Parquet size limit): whether to decide roles from a sample of the
  first rows. For now the first 64KB of the contents is indexed
- The ADR for personal-data detection (making ADR-006's `PiiScanner` concrete)
- Whether column names join the material for resource embeddings (ADR-054)
- Using numeric and date ranges as filters (together with extended-metadata filters)
- Using word-based similar-resource search to find tables with the same columns
- XLSX (after ADR-057)

## Related ADRs

- ADR-006: Quality Monitor as a core feature (`PiiScanner`)
- ADR-021: Resource content full-text search
- ADR-029: CSV/TSV preview Parquet column type inference
- ADR-032: MCP data query (this ADR extends Part A)
- ADR-034: Metadata vector search
- ADR-043: Resource versioning and row-level diffs
- ADR-046: Fixing the original and separating its interpretation
- ADR-048: Modeless table preview
- ADR-054: The embedding unit is the resource
- ADR-057: Interpreting plain-table XLSX as tables
- ADR-059: Heavy worker processing in one reused child process
- ADR-061: Move search to PostgreSQL
