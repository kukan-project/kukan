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
  inference of every resource with a table profile matched against an older state. The job (`refresh-vocabulary-profiles`) is queued when the setting
  changes and when a worker starts, which a release changing a pack or the rules reaches. For now the
  rebuild interprets the table again from the stored original (`rebuildOnly`, ADR-044 §4); since the
  state changes seldom, a route that rebuilds the profile alone waits until the volume calls for it

### 5. Rules for judging

Based on the trial, judgment relies mainly on values, with column names as support.

| Level                  | Rule                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate for settling | Representation with a check digit (6-digit local government code): match rate against the code table ≥ 0.9, regardless of column name                                                                                                                                                                                                                |
| Candidate for settling | Names: match rate ≥ 0.8 (including aliases, abbreviations and district names; non-area values and values that stay ambiguous are excluded from the denominator, provided the rate with the ambiguous counted as misses is still ≥ 0.5)                                                                                                               |
| Candidate for settling | Code without a check digit (5 digits): match rate ≥ 0.9, with at least 50 areas below the top level, or at least 20 spread under at least 2 areas at the top                                                                                                                                                                                         |
| Needs corroboration    | Other short codes (2 digits, or few 5-digit values): on at least 90% and at least 3 of the pairs where both name an area (with at least 2 distinct codes), the code is the name's area (its codes before renumbering included) or an area containing it; or a column name naming the representation ("都道府県コード"; "コード" alone is not enough) |
| Needs corroboration    | Codes with a match rate of at least 0.8 but under 0.9 (a statistics table with aggregate rows): settled only by a name column of the same table, not by a column name                                                                                                                                                                                |
| Not used               | Rescuing by zero-padding from values alone                                                                                                                                                                                                                                                                                                           |
| Not decided            | Schemes that both match with the same shape (such as the codes of Korea's two bodies) are left to a person to settle as "several candidates"                                                                                                                                                                                                         |

- Judgment is done on the interpreted table's values read as strings, with no separate path of
  reading. The reader reads every row before settling a type (ADR-046), so a column with even one
  value starting with 0 stays text. A column inferred as integers has no 0 to lose, and read back as
  strings its values are the originals. A value whose 0 was already dropped in the file (`11002`) is
  not rescued: in the trial, padding with 0 on the values alone was almost all false positives
- 5-digit codes without a check digit may be settled on values alone because the codes matched against are a tiny part of the 5-digit space (about 2,900, retired ones included), and unrelated numbers almost never match 90% of the
  time by chance. The danger is codes that run in blocks overlapping a serial number: a number
  counted from 13101 is exactly Tokyo's 23 wards. Measured on the code table, a serial run from any
  start matches at most 42 codes while keeping 90% (2026-11-15). That is why a column within one
  prefecture needs 50, and one spread over two or more needs 20. Areas at the top level are not
  counted: they are few and nearly fill a short code's space (the days 01–31 of a month are 31
  prefectures)
- In corroboration by a name column, a prefecture code beside a municipality's name counts as
  agreeing (the code's area contains the name's). A renumbered city (such as Hamamatsu) agrees under
  its code from before the change too
- A short-code column with neither corroboration nor a column name records no vocabulary at all.
  Offering a column of dates as a join candidate does more harm than a miss, which a person's
  assignment makes up for
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
  kept as several candidates. Where the same table has a code column of the same scheme, the row's
  code decides it (the place that code names, or one it lies in: 中央区 beside 13102 is Tokyo's). With
  a name column alone, a value that stays ambiguous counts toward neither the match rate nor the
  coverage, and is left out of the denominator too (counted as a miss, it lowers the rate most in the
  tables with the most special wards or shared city names), though a column whose rate with them
  counted as misses is under 0.5 is not decided
- The aggregate rows statistics tables put between municipalities are non-area values, left out of
  the denominator: 区部, 市部, 郡部, 町村部, 島部, and values ending in 計, 郡, 地域, 圏域, 支庁 or 振興局 (no
  municipality's name ends so). Tokyo's population table has 9 of them in 72 rows, and without
  leaving them out its rate fell short of 0.8 (2026-11-15)
- The codes of aggregate rows (13100 区部, 13360 大島支庁) are in no code table, so a code column whose
  rate is at least 0.8 but under 0.9 is settled only when a name column of the same table bears it
  out. Rows whose code is in no table drop out of the pairs (the name beside them is not checked).
  Tokyo's codes match 63/72 = 0.875, and the other 9 rows are all aggregates
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
- Packs are identified by country/region code (such as ISO 3166 `JP`) and enabled in site settings (the runtime setting `vocabulary-packs`, ADR-036), empty by default.
  No default country is embedded in the core
- The registry's shape is general from the start (names with languages, validity periods,
  correspondence tables with ratios, multi-column representations, hierarchies whose parent is
  looked up in a correspondence table). It holds as shape what the Japan pack alone would not need
- The tests include one fictitious non-Japan pack (a code scheme with no check digit and with mixed
  letters), always confirming that the core does not assume Japan
- Display names of countries/regions are set per language. Keys are ISO codes, and names carrying a
  political claim are not written into the core

### 9. The master of a scheme, and its extensions

The Japan pack's scheme changes from the Ministry of Internal Affairs and Communications' Local
Government Code (全国地方公共団体コード) to the same Ministry's "Standard Area Code for Statistics"
(統計に用いる標準地域コード). Statistics tables
put groups of areas such as counties (郡), subprefectures (支庁) and the ward area (区部) among the
municipalities, and their codes are not in the local government code table (§5). The standard area
code holds the groups as entries. The scheme called the Local Government Code in §1 and elsewhere is
read as the standard area code from this section on.

The entries are built from two lists. Local governments (prefectures, municipalities and the wards
of designated cities) come from the Digital Agency's City Master (市区町村マスター, part of the Address
Base Registry), and only the groups of areas it lacks are added from the Ministry's standard area
code. The City Master holds each local government's code, name, kana and romanization, and also the
name, kana and romanization of the county on each town's row.

**The master contains the local government codes.** The standard area code's nationwide CSV (updated
2023-08-22, 2,291 rows) contains all 1,965 current local government codes (prefectures,
municipalities and the wards of designated cities: every 5-digit body is there, and the check digit
is the same mod 11), and in addition 326 groups of areas: 307 counties, 18 subprefectures and
regional promotion bureaus (支庁・振興局), and 1 ward area (特別区部). Only one name differs: the Ministry's
Local Government Code list's 「梼原町」 is 「檮原町」 in the standard area code (「檮」 is the formal character, 「梼」 a
common substitute) (2026-11-15).

**The City Master agrees with the standard area code's local governments.** Its nationwide CSV
(updated 2024-03-12, 1,918 rows) has one row per municipality and designated-city ward, with the
prefecture in columns of each row. Its codes match all 1,918 local governments of the standard area
code other than prefectures, with no name differing (「檮原町」 there too). It includes Hamamatsu's ward
reorganization of 2024-01-01. It holds no retired local government (`ablt_date` is empty
throughout). All 307 counties of the standard area code joined the City Master's counties by
prefecture and county name; 66 Hokkaido counties are in the City Master only (the standard area code
divides Hokkaido by regional promotion bureau) (2026-11-16).

- **The scheme's ID changes from `jp-lg-code` to `jp-area-code`,** labelled "Standard Area Code for
  Statistics (including the Local Government Code)". No person has settled an assignment yet
  (`column_settings.concepts`), so nothing needs moving; inferences are rebuilt by raising the rules'
  version (§4)
- **Entries carry a kind:** `lg` (holding a local government code: prefectures, municipalities and
  the wards of designated cities) or `group` (a group of areas, with a finer division of county,
  subprefecture, regional promotion bureau or ward area). A designated city's ward is not a local
  public entity but has a local government code, so the kind divides by "has a local government
  code", not by "is a municipality". The kind also decides the source (`lg` from the City Master,
  `group` from the standard area code). The local government codes are exactly the `lg` entries, so the representations (6 digits, 5 digits, the 2-digit
  prefecture code, name) stay as they are. The CSV has 5 digits; the 6 digits are made by appending
  the check digit by the same rule. The Ministry's own resident register population tables also write
  counties in 6 digits with the same check digit (`023001` 東津軽郡)
- **Groups are not counted as levels and do not enter the tree of parents.** A group's parent is its
  prefecture; a town's parent stays its prefecture, and the group it belongs to is held separately.
  Hokkaido's towns are placed under regional promotion bureaus, not counties, so putting groups in the
  tree would give towns of the same level parents of different kinds: a bureau in Hokkaido, a county
  elsewhere. Levels and coverage ("45 of the 47 prefectures") are counted over local governments only.
  Nor are groups places to filter a search by (1c's `area_places`); they count only toward the
  prefectures a table spans (`area_roots`)
- **Aggregate numbers a prefecture assigns on its own go in an extension layer on top of the
  master.** Each entry has its source (publisher, dataset), its kind (aggregate), its name, and its
  hierarchy level where there is one. Tokyo has `13200` 市部, `13350` 島部 and `13550` 町村部 (the
  Tokyo Metropolitan Government Bureau of General Affairs Statistics Division's CSVs, area hierarchy
  column 0–4); Saitama has `11001` 市計 and `11002` 町村計 (area identifier a/b/c/0/1); Akita has
  `05001` 市部計 and `05002` 郡部計. Akita's tables write `5001`, with the leading zero dropped, and it
  is not rescued (§5)
- **Extension entries are matched as a pair of code and name.** The same number covers different
  areas by source: the Ministry's resident register population table uses `133604` for 「島しょ」 (all
  the islands, 23,272 people, the same as Tokyo's 島部), while `13360` in the standard area code is
  大島支庁. In a column of codes alone, extension entries are not counted as hits. Generic words such
  as 区部, 市部 and 郡部 are likewise matched only in a pair with a code, never by a column of names
  alone
- **Names, kana and English names come from the City Master.** Disagreements are listed at
  generation, and the City Master wins by default. Its kana differed from the standard area code's
  readings (hiragana) for 6 local governments and 2 counties (別海町, 留夜別村, 田子町, 南部町, 真鶴町,
  有田町; 三潴郡, 与謝郡). Only those confirmed wrong (真鶴町 reads 「まなづる」, as the town gives it) are
  corrected, by the pack's table of corrections. Subprefectures' and bureaus' kana come from the
  standard area code's readings; the ward area (its reading blank) is filled by the pack
- **English names take the form of the Geospatial Information Authority of Japan's rules for English
  place names (地名等の英語表記規程).** The City Master's romanization is not in that form: it keeps the
  Japanese suffix (`Sapporo-shi`, `Chiyoda-ku`, `Manazuru-machi`, counties `Takaoka-gun`, prefectures
  with no suffix, `Tokyo`), and writes 「ん」 before b, m and p as m (`Gumma`, `Gotemba-shi` and 30
  more). The generator keeps the name part and changes two things. The suffix is replaced by the
  English word as articles 13–15 of the rules give (`-shi` City; `-ku` Ward, City for Tokyo's 23
  wards only; `-cho`/`-machi` Town; `-mura`/`-son` Village; `-gun` County; prefectures Prefecture;
  Tokyo Metropolis; Hokkaido Prefecture), and 「ん」 is always n, as the rules' notes say (`Gunma`).
  Long vowels (`Ome`, `Chuo`) are already as the rules have them. The 19 subprefectures, bureaus and
  the ward area are outside the rules and are named by the pack (e.g. Ishikari Subprefecture).
  Matching English names (columns of names in English tables) is a later step
- **The generator checks the two lists against each other.** It stops when the set of local
  government codes differs between the City Master and the standard area code, and when a county does
  not join by prefecture and name
- **The patterns of values that are not areas (ending in 「〜計」「〜郡」「〜地域」「〜圏域」「〜支庁」
  「〜振興局」, §5) are kept.** Over 2,060 e-Gov CSV files and 30,347 columns, adding the standard area
  code's groups with the patterns kept changed nothing (204 columns settled, 234 unsettled), and
  removing the patterns lost one column (old subprefecture names absent from today's list). The sample
  had no code column holding group codes, so the gain could not be measured. Measuring it on the
  statistics CSVs of Tokyo and Saitama is the next measurement
- **Name folding gains variant-character folding** (「梼」→「檮」 and others). The character pairs are
  held as the pack's data; the core holds only a folding "replace characters by the pack's table" in
  its closed list (§8). Over the current names, switching the master found one difference, 梼原町
- **Matching a county by its name alone is weak.** Hokkaido's towns sit under regional promotion
  bureaus and have no county entries, and 6 county names repeat across prefectures (三島郡, 大島郡,
  安芸郡, 愛知郡, 海部郡, 熊毛郡). A county name is settled only in a pair with a parent column or a code
- **History combines two lists.** The City Master holds no retired local government, and the
  standard area code's list of changes covers only 2007-04-02 onward. Changes of local governments
  keep the current source (the Ministry's Local Government Code list of changes since 2005) over the whole period, and from the standard area code's list come the changes
  of groups (27 counties deleted, and 14 subprefectures renamed to regional promotion bureaus on
  2010-04-01). The 113 local governments retired since 2007-04-02 agreed in both code and date between
  the two lists. The generator checks the overlap and stops on a disagreement. Groups gone by
  2007-04-01 are not held. The first implementation holds groups as they stand now, and takes in
  this list of changes, with the overlap check, later (the list is an `.xls`, which the DuckDB
  `excel` extension the generator uses does not read). Until then a retired county's code misses
- **The terms of use are the same as now.** The standard area code's page and CSV carry no rights
  notice, so they fall under the Ministry site's copyright terms: 「当ホームページで公開している情報
  （以下「コンテンツ」といいます。）の著作権は、特記されていない限り総務省に帰属し、権利表記の記載がない
  限り「公共データ利用規約（第1.0版）」に準拠した利用条件の下で利用することができます」 ("The copyright
  of the information published on this website ... belongs to the Ministry unless otherwise noted, and
  unless a rights notice states otherwise it may be used under terms conforming to the Public Data
  License (version 1.0)"). The only exclusions are 「組織や特定の事業を表すシンボルマーク、ロゴ、
  キャラクターデザイン」 (symbol marks, logos and character designs) and 「別の利用ルールの適用を明示して
  いるコンテンツ」 (content that states another rule applies), and neither applies. The pack appends
  check digits and changes the shape, so besides the source it states 「編集・加工等を行ったこと」 (that
  it was edited or processed; item 1.1 イ of the same terms). The City Master is under the Public Data
  License (version 1.0) too: the pack states the source and that it was processed (English names
  replaced, readings corrected). Each extension entry's terms follow its source
- **e-Stat's Statistical LOD (統計 LOD) is not used.** It holds the standard area code as RDF (CC BY
  4.0); its current entries match the standard area code's CSV, with English names and readings.
  But it has no bulk dump, SPARQL returns at most 10,000 rows a query, and its English names have
  the same suffixed form as the City Master's. It adds nothing, so it does not become another source

Sources (retrieved 2026-11-15 and 16):

- Ministry of Internal Affairs and Communications, 「統計に用いる標準地域コード」
  <https://www.soumu.go.jp/toukei_toukatsu/index/seido/9-5.htm> (nationwide CSV
  <https://www.soumu.go.jp/main_content/000323625.csv>; changes since 2007-04-02
  <https://www.soumu.go.jp/main_content/000323626.xls>)
- Ministry of Internal Affairs and Communications, 「当省ホームページについて」, copyright
  <https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html>
- Digital Agency, 「アドレス・ベース・レジストリ」 <https://www.digital.go.jp/policies/base_registry_address>
  (City Master, nationwide <https://data.address-br.digital.go.jp/mt_city/mt_city_all.csv.zip>;
  terms of use <https://www.digital.go.jp/policies/base_registry_address_tos>)
- Geospatial Information Authority of Japan, Ministry of Land, Infrastructure, Transport and Tourism,
  「地名等の英語表記規程」 (revised 2026-03-24) <https://www.gsi.go.jp/common/000138865.pdf>

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

- **Schemes with few distinct values cannot be picked up automatically.** A 2-digit prefecture code,
  or a 5-digit code with few values, is not made a candidate unless the same table has a name column
  or a column name naming the representation. Misses are made up for by human assignment. 2-digit
  codes read as integers for lack of a leading 0 (columns of 10–47 only) are not read. A column of
  ward names alone ("中央区") is judged a name column only with at least 3 wards whose names are not
  shared, and otherwise cannot corroborate the codes of a designated city's wards
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
