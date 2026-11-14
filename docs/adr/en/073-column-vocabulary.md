> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/073-column-vocabulary.md`](../jp/073-column-vocabulary.md).

# ADR-073: Assign Vocabulary to Columns (Three Layers of Concept, Scheme and Representation; Administrative Areas First; the Registry Starts from Presets)

## Status

**Proposed** — 2026-11-14.

Express "what a table's column refers to" with a vocabulary that KUKAN holds. The vocabulary is
split into three layers: **concept** (a meaning independent of country, such as administrative
area), **scheme** (a code system defined by a country or body, such as the Local Government Code
of Japan), and **representation** (a way of writing, such as 6 digits, 5 digits or a name).
Assignments to columns are inferred by rules during interpretation and settled by a person.

The first target is administrative areas only, and the registry is limited to presets shipped with
the product. The first pack is Japan's administrative areas, but nothing country-specific goes in
the core, so packs for other countries can be added later.

## Context

### 1. Vocabulary is the precondition for joining tables

Joining several tables is not hard in itself. DuckDB can read several files and catalogs in one
session. What is hard is saying with confidence that "this column and that column refer to the same
thing".

KUKAN today holds column types (ADR-046) and roles (ADR-063), but a role can only go as far as
`identifier`, that is, "some kind of code". It cannot tell whether that is the Local Government
Code, a corporate number or a postal code. The existing `vocabulary` table is the tag vocabulary
inherited from CKAN; it is attached to datasets and is a different thing from the meaning of a
column.

The questions that need a column's meaning fall into three:

- **Meaning**: what does this column refer to (administrative area, corporation, address)
- **Representation**: how are the values written. Even for the same administrative area, the
  writing varies: 6 digits with a check digit, 5 digits without one, a name, or a number with the
  leading 0 dropped
- **Point in time**: which time's scheme. Codes change when municipalities merge

### 2. Findability comes before joining

Once vocabulary is assigned, the following become possible before joining is implemented:

- Show "Prefecture (local government code)" in the column list on the public page
- Narrow search to "tables containing a municipality code"
- From a local government code column with only one distinct value, show the dataset's target area
- Serve as the basis for correspondence tables to standard data models (datamodels.jp, schema.org,
  etc.) and JSON-LD output (handled in a separate ADR)
- When AI joins tables via MCP, it no longer has to guess from column names

### 3. Code schemes differ by country, but the skeleton is shared

Most countries have a code scheme for administrative areas: the US FIPS (2-digit state + 3-digit
county), the UK GSS (`E06000001`), the French INSEE (5-character commune, with `2A`/`2B` for
Corsica), the German AGS (8 digits), the Korean administrative standard code (10 digits), Taiwan's
Ministry of the Interior administrative area codes, the EU's NUTS, and so on.

The problems that appear with Japan's local government codes show up almost unchanged in each
country:

- **Leading zeros** (FIPS, INSEE, AGS). Reading them as numbers breaks them
- **Mixed letters** (`2A`, `E06…`). Assuming "a column of digits" misses them
- **Point in time**. Codes change with mergers, reorganizations and restructuring, and the handling
  differs by country (the UK assigns new codes and does not reuse them, Norway renumbered, Taiwan's
  county and city codes changed with the 2010 reorganization)

Meanwhile, other countries break assumptions one would make by looking only at Japan:

- **Hierarchies are not trees**: a US Place (city or town) crosses counties, and its parent is the
  state. In Korea, legal dong and administrative dong sit side by side as two systems with different
  boundaries. In the UK GSS, the prefix denotes a type, not a parent
- **Parallel schemes**: in Korea, two schemes with different numbering by the Ministry of the
  Interior and Safety and by Statistics Korea coexist and cannot be told apart by shape alone
- **Many-to-many correspondence**: US ZIP and county, and Korea's legal dong and administrative
  dong, correspond only through a many-to-many table with ratios. The Australian Bureau of
  Statistics and Eurostat actually publish correspondence tables of this shape
- **One key over several columns**: US `STATEFP` and `COUNTYFP`; Japan's local government code and
  town/block ID
- **Multilingual names**: English and French in Canada; 「臺／台」 and several romanizations in
  Taiwan

### 4. Trial

From all 1,157 datasets on the e-Gov Data Portal that include CSV, we collected 2,077 files and
36,513 columns, and matched each column against the Ministry of Internal Affairs and
Communications' Local Government Code (Reiwa 6 / January 1, 2024 edition, including wards of
designated cities) and 978 old codes taken from the list of revisions since Heisei 17 (2005)
(2026-11-13). The trial scripts and the collected data are not included.

| Format                                           | Columns found             | Result                                                                                                                       |
| ------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 6 digits (with check digit)                      | 98 columns (73 files)     | 0 false positives in what we checked. Also caught columns with no column-name clue and columns whose header detection failed |
| 5 digits                                         | 2 columns                 | Both correct                                                                                                                 |
| Rescue treating 4 digits zero-padded as 5 digits | 26 columns                | All false positives (population by age, budget amounts)                                                                      |
| 2-digit prefecture code                          | 1,078 columns (555 files) | On values alone, almost all false positives (day of a date, age, counts)                                                     |
| Names (prefectures, municipalities)              | Dozens of columns         | Mostly correct. Issues below                                                                                                 |

- The check digit formula (mod 11) matched in all 2,943 cases
- Over 70% of the 6-digit columns (72 of 98) had only one distinct value. In the format of the
  Standard Municipal Open Datasets, the local government code column holds only that
  municipality's code
- When 2-digit candidate columns were matched row by row against a prefecture-name column in the
  same table, the match rate for false-positive columns (line-item numbers, rankings, etc.) was
  0–0.02, while the real one (production-area code) was 100% on the rows present in the code table.
  It did not reach 1 overall because non-area rows are mixed in, such as `0` = total and
  `150` = imports
- Problems with name matching: a ward name alone for a designated city's ward (Fukuoka City's
  「中央区」 (Chuo Ward)) collides with Tokyo's special wards. Towns and villages prefixed with a
  district name (「石川郡玉川村」 (Tamakawa Village, Ishikawa District)). Non-area values (「全国」
  (nationwide), 「合計」 (total), 「（海上）」 (at sea)). Columns referring to the local government
  as an organization rather than an area (「所有者等」 (owner, etc.))
- Two columns contained old codes, both in tables with the note 「市区町村単位は 2014 年 4 月時点」
  (municipality units as of April 2014). Of 1,742 values, one was an old code, and the difference in
  match rate is only 0.001
- 6-digit codes with the leading 0 dropped (5-digit numbers) did not appear in the published CSVs.
  The 0 is dropped inside the tools that make the file, such as Excel
- 70% of the sample is from the Ministry of Health, Labour and Welfare and the Ministry of the
  Environment, and only two cities represent municipalities

## Options Considered

### A) Assign by a column-name dictionary alone (rejected)

Headers in Japanese government CSVs are not in consistent positions; note rows get read as headers,
and columns shift (in the trial, columns whose header detection failed were still correctly picked
up by their values). Column names also vary for the same meaning. Column names stay as one clue,
and judging by values is primary.

### B) List each country's codes flatly as concepts (rejected)

If "local government code", "FIPS" and "GSS" each become a concept, concepts grow with every
country, and neither cross-country correspondence nor the relationship between representations
under the same concept (6 digits and 5 digits) can be expressed. The shape of the registry would be
dragged along by the first country.

### C) Use external vocabularies directly as concept IDs (rejected)

schema.org, IMI and datamodels.jp have terms for administrative areas. But some are revised and
some are pre-release, and they do not hold the information needed for joining, such as code tables,
normalization and point in time. External vocabularies are held as correspondences (sameAs), and
KUKAN owns the IDs.

### D) Three layers of concept, scheme and representation, with a KUKAN registry (adopted)

## Decision

### 1. Split the vocabulary into three layers

```
Concept (generic)     Scheme (country/region pack)              Representation
Administrative area   Local Government Code (JP)                6 digits (with check digit) / 5 digits / name
  └ Level: ADM1–3     FIPS (US), GSS (UK) …                     …
```

- **Concepts** are few and independent of country. Initially only administrative area is defined
- **Schemes** go into per-country/region packs
- **Representations** sit under a scheme. If 6 digits and 5 digits were separate concepts or
  separate schemes, the pairs that can be joined would not be found
- The **level** of an administrative area maps to generic levels (ADM1, ADM2, ADM3). This absorbs
  differences in what each country calls its hierarchy levels (prefecture vs. state, municipality
  vs. county), the same idea as humanitarian P-codes and GADM

### 2. What a scheme holds

| Item                                                     | Example (Local Government Code)                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Country/region, issuer                                   | `JP`, Ministry of Internal Affairs and Communications                         |
| Terms of use (including whether modification is allowed) | Public Data License (version 1.0): modification allowed, attribution required |
| Level                                                    | Prefecture → ADM1, municipality → ADM2, ward of a designated city → ADM3      |
| Parent                                                   | Given on each entry (worked out by the pack's generator)                      |
| Check digit                                              | mod 11 (chosen from a closed list)                                            |
| Representations                                          | 6 digits, 5 digits, name                                                      |

The parent is given on each entry of the code table, and the core holds no rule for working it out
from a code. How a parent is found differs by country (the first 2 digits; a varying length, as for
the French overseas departments, where the parent of `97101` is `971`; a table to look up, as for
the UK GSS and the US Place), so the pack's generator, which knows it, works it out and writes it in.
When a revision changes a check digit rule, the rule is added to the closed list and the pack's
version goes up. The pack's version is part of the registry state, so the inferences are rebuilt.

### 3. Code tables and correspondence tables become KUKAN resources once sites can update them

- A **code table** holds, per row, a code, level, parent, validity period, and names (several, each
  with language and kind [official, alias, romanization system]). It is kept by validity period
  rather than by version, and the table at a given point in time is cut out from the validity
  periods
- A **correspondence table** has a common shape: "(scheme, code, point in time) → (scheme, code,
  point in time), ratio, basis of the ratio (area, population, count, none)". Mergers (many-to-one;
  many-to-many for split annexations), reorganizations, mapping between parallel schemes, and
  many-to-many correspondence are all received in the same shape. A one-to-one old/new mapping is
  the case where the ratio is 1
- **Where they live changes with the phase.** While the registry is presets only (Steps 1–3), code
  tables and correspondence tables ship with the product as files inside the pack. From Step 4,
  when sites can update them, they are placed as KUKAN resources, with their update history held by
  layer-1 versions (ADR-043). Making them resources means creating a system-owned dataset on each
  site and deciding its visibility and how the pipeline treats it, none of which inference and
  display need. Their shape (validity periods, names with languages, ratios) is the same from the
  start, so moving them does not change what reads them

### 4. Split column assignments into inferred and settled

This rides the existing two-layer split as is (inferences are rebuilt by interpretation every time;
human decisions are in `column_settings`).

- **Inferred**: judged when interpretation builds the profile, writing the concept, scheme and
  representation (`concept` / `scheme` / `representation`) and their basis (`conceptBasis`) into the
  column of the table profile (`resource_pipeline.profile`). Placed the same way as roles (`role` /
  `roleBasis`, ADR-063), not in `schema`, which is frozen onto the version: when the rules change,
  rebuilding the live version's profile is enough. The concept alone cannot tell the 6-digit code
  from the name, so the inference carries the scheme and representation too
- **Settled**: `resource.column_settings.concepts` holds the mapping from a column (or a set of
  columns) to a scheme and representation. Only people write it
- **Settling does not create a version.** A concept does not change how the bytes are read, so it is
  not an input to the version gate (spec `phase-versioning-2-ducklake.md` §6.5) and is not frozen
  into a version. It is the same "save without creating a version" as the role override (ADR-072
  Decision 5)
- **Several columns can point to one representation** (prefecture name + municipality name, state
  code + county code)
- **When a concept implies a type, propose a settled type in the same draft.** If a local government
  code column is inferred as integer, propose the settled type `string`. Applying it creates one
  version for the type part only (ii-c's settled types, spec §8)
- A column known to hold a code representation (6 digits, 5 digits and so on) gets the role
  `identifier`. A column holding the name representation keeps its role: the values of `name` and
  `category` columns are search terms (ADR-063), and making it `identifier` would stop a table being
  found by a municipality's name
- Level and coverage ("45 of the 47 prefectures") are derived from the values and are not settled by
  people. Since the shape of a 6-digit local government code is shared by prefectures and
  municipalities, the level is determined by the values, not the column. They are stored on the
  profile's column with the inference (the set of levels present, and per level the number of codes
  matched and the level's total). The public page and the search index build display and filtering
  from the profile, without reading the Parquet again
- **The profile records the state of the registry it matched against**: the version of the inference
  rules, the set of packs enabled on the site and the version of each. When that changes (rules or a
  pack updated in a release, from Step 4 a site
  updating its code tables, or a site enabling or disabling a pack), the inference of tables matched
  against the old state stays stale. Since some columns first match through a post-merger code, a
  newly added alias or a newly enabled scheme, a change of state queues a job that rebuilds the
  inference of every resource with a table profile matched against an older state. The rebuild
  redoes neither the fetch nor the interpretation, only the profile and the index (the procedure is
  settled in implementation)

### 5. Rules for judging

Based on the trial, judgment relies mainly on values, with column names as support.

| Level                  | Rule                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate for settling | Representation with a check digit (6-digit local government code): match rate against the code table ≥ 0.9, regardless of column name        |
| Candidate for settling | Names: match rate ≥ 0.8 (including aliases, abbreviations and district names; non-area values are excluded from the denominator)             |
| Needs corroboration    | Short codes (2 or 5 digits): agree with a name column in the same table on the rows present in the code table, or a reliable column name     |
| Not used               | Rescuing by zero-padding from values alone                                                                                                   |
| Not decided            | Schemes that both match with the same shape (such as the codes of Korea's two bodies) are left to a person to settle as "several candidates" |

- Judgment is done on the interpreted table's values read as strings, with no separate path of
  reading. The reader reads every row before settling a type (ADR-046), so a column with even one
  value starting with 0 stays text. A column inferred as integers has no 0 to lose, and read back as
  strings its values are the originals. A value whose 0 was already dropped in the file (`11002`) is
  not rescued: in the trial, padding with 0 on the values alone was almost all false positives
- A column with a single distinct value is also offered as a candidate for the dataset's target area
- Point in time cannot be told from differences in match rate. The presence of codes valid only in
  that period is the evidence. The inferred point in time is stored on the profile as the set of
  periods where the validity periods of all matched codes overlap, with its basis (which codes
  narrowed it). A set, so that a code retired and later given out again does not count as valid in
  between. With no
  code narrowing it, it is "consistent with the current scheme", and normalization and joins read it
  as the present. With no overlap (codes from different points in time mixed), no point in time is
  decided, and that is recorded as is
- A ward name alone for a designated city's ward is resolved using the publishing organization as a
  clue
- A name that matches several codes within one scheme (府中市 Fuchū, 伊達市 Date) is resolved when a
  parent column (the prefecture name) or the publishing organization makes it unique, and is otherwise
  kept as several candidates. A value that stays ambiguous counts toward neither the match rate nor
  the coverage
- AI is limited to suggestions for columns the rules could not decide (a person settles, as in
  ADR-040 and ADR-057)

### 6. Concept IDs do not depend on the site

Concept IDs live in a product-wide namespace. They are the same on an internal government site and
on a public site, so assignments made internally still hold when moved to the public side. External
vocabularies are held as correspondences (sameAs).

IDs for what a row refers to (facilities, etc.) and their base URIs are handled in the standard data
model ADR. Since joining is done by code, joins do not break even if the form of entity URIs differs
per site.

### 7. Treat the registry differently per layer, and start with presets only

| Layer                                                 | Treatment                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concepts                                              | Presets only. If sites added them, IDs would diverge per site                                                                                                 |
| Scheme mechanics (structure, check digit, conversion) | Held as product code. Adding one is a change to the product. Conversions are a closed list; no formulas can be written                                        |
| Code tables, correspondence tables                    | Initial values are presets (files inside the pack). From Step 4 they become resources, and sites can publish new versions (mergers do not wait for a release) |
| Site-specific schemes                                 | Only declared as combinations of existing parts. Not used for automatic inference, only for human assignment                                                  |

Site-specific schemes are not used for inference because in the trial, schemes with few distinct
values (1–47) were riddled with false positives on values alone. Only schemes with a check digit or
with enough distinct values go into inference.

**The first phase is presets only.** Screens, permissions and validation for additions come in later
phases. Since the shape of the code tables is the same from the start, neither moving them into
resources nor adding schemes changes the shape of the registry.

### 8. Even if the first pack is Japan, it is not Japan-only

- Nothing country-specific goes in the core. The local government code's check digit and "the first
  2 digits are the parent" go inside the Japan pack
- Packs are identified by country/region code (such as ISO 3166 `JP`) and enabled in site settings.
  No default country is embedded in the core
- The registry's shape is general from the start (names with languages, validity periods,
  correspondence tables with ratios, multi-column representations, hierarchies whose parent is
  looked up in a correspondence table). It holds as shape what the Japan pack alone would not need
- The tests include one fictitious non-Japan pack (a code scheme with no check digit and with mixed
  letters), always confirming that the core does not assume Japan
- Display names of countries/regions are set per language. Keys are ISO codes, and names carrying a
  political claim are not written into the core

## Consequences

| Location                                                    | What changes                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                           | Types for concept, scheme, representation and assignment. Add `concepts` to `column_settings`, and the inference to the table profile's columns |
| Registry location (new)                                     | Packs (scheme mechanics) and the initial code tables and correspondence tables                                                                  |
| `apps/worker/src/pipeline/interpret/table/table-profile.ts` | Judgment. Writes `concept` / `scheme` / `representation` / `conceptBasis` into the profile's column                                             |
| `column-role.ts`                                            | Makes columns known to hold a code representation `identifier`                                                                                  |
| "Table settings" tab (ADR-072)                              | A vocabulary field. Showing candidates, settling, proposing settled types                                                                       |
| Public page's column list, search index                     | Showing and filtering by vocabulary                                                                                                             |

## Steps

| Step | Contents                                                                                                                                                             | Prerequisite  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1    | The registry (presets, with code tables as files inside the pack) and the Japan pack (administrative areas). Inference, and display on the public page and in search | None          |
| 2    | Settling and settled-type proposals on the "Table settings" tab. A cross-resource index, display of "joinable tables"                                                | ii-c, ADR-072 |
| 3    | Make normalization conversions usable in queries. Queries across several resources, MCP tools                                                                        | Step 2        |
| 4    | Move code tables and correspondence tables into resources, so that sites can update them                                                                             | Step 1        |
| 5    | Site-specific schemes                                                                                                                                                | Step 4        |
| 6    | Packs for other countries (expected order: Taiwan → Korea → US → EU)                                                                                                 | Step 1        |

Taiwan's pack comes first because it can reuse almost all of Japan's parts, which lets us confirm
how small the work of adding a pack is. Korea has many parallel schemes and collisions, which puts
load on the core. The order lets the core be fixed while there are still only two packs.

## Trade-offs

- **Schemes with few distinct values cannot be picked up automatically.** A 2-digit prefecture code
  is not made a candidate unless the same table has a name column or there is a reliable column
  name. Misses are made up for by human assignment
- **At first, sites cannot add schemes.** In-house codes must wait until step 5
- **The registry's shape is excessive for the Japan pack alone.** Accepted as the cost of not
  rebuilding the core when other countries are added

## Open Issues

- **Distinguishing area from organization**: the local government code in "list of municipalities
  working on open data" refers to an organization, not an area. Joining does not need the
  distinction, but in JSON-LD the types differ. Whether an assignment should carry "area or
  organization" is decided in the standard data model ADR
- **Shape of the cross-resource index**: human decisions sit in `column_settings`, but a question
  like "all tables that have a local government code" needs a cross-resource index. Should it be a
  table that can be rebuilt as a derivative? Spec §6.2 says "move to a dedicated table once lookups
  across columns become necessary"
- **Shape of value summaries**: to estimate "joinable tables", summaries of the normalized values
  are held — the set itself when there are few distinct values, or a summary such as MinHash when
  there are many. The threshold and the shape
- **Following column renames**: settlements are looked up by column name, so they come off when a
  column is renamed. Since concepts do not create versions, this is less noticeable than with
  settled types
- **Sample bias**: re-measure name matching (ward names, district names, spelling variants) on
  data from municipal portals
- **Old codes before Heisei 17 (2005)**: not in the trial's code table
- **Pack maintenance**: code tables change every year. Who updates packs, and how they are
  distributed to closed networks
- **UI language**: sites using another country's pack need a UI in that country's language

## Related ADRs

- ADR-040: AI metadata suggestions (suggestions for columns the rules cannot decide)
- ADR-041: Multi-site deploy (packs are enabled per site)
- ADR-043: Resource versioning (code table history is layer-1 versions; the version gate for
  settled types)
- ADR-046: Interpret stage (judgment happens inside interpretation, on the interpreted values read
  as strings)
- ADR-057: XLSX as tables (AI only suggests; a person settles)
- ADR-063: Table profile (how roles and their basis are placed; `identifier`)
- ADR-064: Site-wide custom metadata (precedent for per-site settings)
- ADR-072: Dashboard dataset editor (the "Table settings" tab; save without creating a version)
