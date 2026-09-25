> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/057-xlsx-table-interpretation.md`](../jp/057-xlsx-table-interpretation.md).

# ADR-057: Interpreting Plain-Table XLSX as Tables (Rules Decide, AI Only Proposes)

## Status

**Proposed — whether to start is decided after measuring the ratio on real data**

Of the XLSX files, those that are a **"plain table" — a single header row over rectangular
data** — are interpreted as tables in the Interpret stage, producing a preview Parquet just
as CSV/TSV do. From there they ride the table preview, row-level diffs (ADR-043 layer 2),
OData (ADR-055) and MCP `/query` (ADR-032) unchanged.

**Whether a sheet counts as a table is decided by fixed rules.** AI does not decide it.
AI's role is limited to **proposing** a table range and header for files the rules did not
accept. A proposal is checked by the rules, confirmed by a person and saved as a settled
value; interpretation from then on is deterministic from that value.

The canonical object (the uploaded XLSX bytes) is untouched. The Parquet is a product of
"interpretation" in the sense of ADR-046.

This ADR makes concrete, for XLSX structure detection, open issue 5 of ADR-046 (making the
producer of an interpretation a replaceable slot). It also answers, with a different
skeleton, the cost ADR-053 §2 stated explicitly: "Excel does not become usable as data."

## Context

### 1. Today, XLSX does not enter the table path

Interpret branches on `isCsvFormat` (`apps/worker/src/pipeline/steps/interpret.ts`), and
XLSX/XLS are not interpreted as tables. As a result:

| Path                     | CSV/TSV                                       | XLSX/XLS                          |
| ------------------------ | --------------------------------------------- | --------------------------------- |
| Preview                  | Table (Range serving + DuckDB-WASM)           | Office Online Viewer (up to 10MB) |
| Column schema            | Recorded per version                          | None                              |
| Row-level diff (layer 2) | Yes (changed-row tracking with a primary key) | None                              |
| OData / MCP `/query`     | Yes                                           | None                              |
| Full-text index          | Table text                                    | Text extracted by officeparser    |
| AI abstract (ADR-053)    | Table material                                | The original is passed as is      |

In municipal open data, it is not unusual for a table to be published only as XLSX. The
catalog can tell what such data is about, but it cannot be touched as data.

### 2. Whether something is a table depends on content, not format

CSV is a table by its very format. XLSX is not. Under the same extension sit:

- plain tables — a single header row and rectangular data
- tables with a title or unit note above and a source or note below
- the so-called "god Excel" with multi-row headers, merged cells and subtotal rows mid-table
- forms, application templates and charts that are not tables at all

So "XLSX means table" is not possible; **each version's interpretation must record "was a
table / was not a table (and why)"**. CSV already has this mechanism —
`resource_version.schema` expresses "interpreted, but no table" with an empty schema
(`NO_TABLE`) and a `reason` (`no-columns`, `too-many-columns`, …).

### 3. Misjudging structure is a data-integrity problem, not a UX one

ADR-053 §2 put it this way: **if the header-row decision shifts by one row on a re-run,
the row-level diff reports every row as changed.** Read the wrong range, and note rows mix
into the data, are served over OData and enter MCP aggregates.

Wrongly making something a table does far more harm than failing to make it one. Failing
to make it one just leaves today's handling (Office Viewer and text indexing) in place.
The decision must lean **toward "not a table" when in doubt**.

### 4. Parts that already exist

| Part                             | Where                                                           | Use in this ADR                                                  |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| CSV interpretation               | `interpretCsv` in `interpret/csv.ts` (DuckDB sniffer)           | Hand the table range over as CSV (decision 4)                    |
| Title-row detection              | `countTitleRows` in `interpret/csv-title-rows.ts`               | Drop single-cell rows above the table                            |
| Footer-row removal               | `trimFooter` in `interpret/csv.ts`                              | Drop sources and notes below the table                           |
| Recording that no table exists   | `NO_TABLE` + `reason`                                           | Keep the reason a file failed the rules                          |
| Column settings a person settled | `resource.column_settings` (primary key; settled types in ii-c) | Hold the settled table range (decision 7)                        |
| Freezing into the version        | A version freezes the settings it was created under (spec §6.7) | Freeze the settled range too                                     |
| Inputs to version identity       | `sameVersionIdentity`                                           | Settling a range creates a version (as settled types do in ii-c) |

## Options considered

### Who makes the decision

#### A) Let AI decide

Pass the original (or the top-left N×M cells and a merge map) to a model and have it
answer "is this a table; if so, what range; how many header rows". It can handle messy
tables too, so it would pick up the highest share of tables.

**Rejected.** There is no guarantee the same input yields the same answer, breaking the
pipeline's determinism (ADR-046). When it returns a plausible error there is no mechanical
way to detect it. On closed networks (`AI_TYPE=none`) the whole feature becomes
unavailable. And deciding a plain table can be verified by rules from the cell grid —
delegating it to AI adds cost and nondeterminism without improving accuracy.

#### B) Decide by rules only

Check mechanically, from the cell grid, for merged cells, the number of header rows,
rectangularity and consistency of column types. Deterministic, explainable, and the same
on closed networks.

**Enough for plain tables, but cannot rescue messy ones.** Files with multi-row headers or
several tables on one sheet cannot be handled without reading meaning, however far the
rules are widened.

#### C) Decide by rules; for files that fail, AI proposes a range and a person settles it — adopted

- Only files that pass the rules become tables automatically (same as B)
- For files that fail, AI **proposes** a table range and header
- The proposal is **checked** by the rules (no merged cells in that range, consistent column
  types). Proposals that fail are discarded
- What a person confirms is saved as a settled value; interpretation from then on is
  deterministic from that value

Because a decision rather than an inference is kept, re-runs do not drift. This is the same
skeleton as ADR-040's "a suggestion, not a decision" and ADR-053 §2's "proposal → human
confirmation → persisted as a settled value". On closed networks there is simply no AI
proposal; the path for a person to specify the range remains.

### Parser for reading XLSX

The decision needs **merged-cell information**. The conversion needs values and types.

| Candidate                            | Merged cells                                         | Notes                                                                                                    |
| ------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| DuckDB excel extension (`read_xlsx`) | Not available (the function has no notion of merges) | Fast conversion but unusable for the decision. Needs pre-INSTALL of the extension (closed networks)      |
| exceljs                              | Available                                            | MIT, pure JS. Cannot read XLS. Merge info under the streaming reader to be confirmed                     |
| SheetJS (xlsx)                       | Available (`!merges`)                                | Reads XLS too. The npm registry version is old; distribution is via its own CDN (a separate supply path) |

**Not decided in this ADR.** The choice is made after the spike (Step 0) confirms memory
use on real XLSX files and how merge information is obtained. Any of these is pure JS or a
DuckDB extension, so the worker is not expected to gain a native dependency (if it does,
the Dockerfile copy-back is needed).

## Decision (proposed)

### 1. The canonical object stays XLSX; the Parquet is a product of interpretation

The XLSX is not converted to CSV to replace the canonical object. Only versions that
interpret as tables get a preview Parquet and a schema. If the interpretation rules change
later, the canonical object does not, and re-interpretation catches up.

### 2. Conditions for a "plain table"

A sheet counts as a table when all of the following hold:

1. **Exactly one sheet can be a table** (the other sheets are empty). This keeps the
   version and Lake premise of one resource = one table
2. **No merged cells within the data range.** Merges outside the range (a title above)
   are allowed if they can be dropped as title rows
3. **A single header row**, with every header cell filled and no duplicates
4. **Rectangular data** — no values outside the header's columns
5. Title and footer rows fall within what the CSV rules (`countTitleRows` / `trimFooter`)
   can drop

The details (blank rows, blank columns around the header, thresholds) are settled in the
implementation spec.

### 3. On failure, fall back to today's handling and record why

A version that fails the conditions is `NO_TABLE`, with the failed condition recorded in
`reason` (e.g. `merged-cells`, `multiple-sheets`, `multi-row-header`, `not-rectangular`).
The preview stays the Office Viewer and full-text indexing is unchanged. **Failing to make
a table is not a failure but an interpretation result: it was not a table.**

The distribution of `reason` is the material for deciding how far to widen the rules and
whether to invest in AI proposals.

### 4. Convert via CSV and hand to the existing CSV interpretation

Write the table range to an intermediate UTF-8 CSV and pass it to `interpretCsv`.

- Cells are written as **raw values, not display formats** (`1234`, not `1,234`)
- Cells formatted as dates are written as ISO 8601 (not as serial numbers; the 1900 leap
  year quirk is absorbed here)
- Formulas are written as their **cached results**. If the range contains a formula without
  a cached result, the sheet is not treated as a table (`reason: 'uncached-formulas'`)

The reason for going through CSV is that type inference, footer removal and applying ii-c's
settled types (the `types` declaration of `read_csv`, spec §6.3) are all implemented in
one place, the CSV interpretation. An XLSX-only path would split these into two.

The cost is that type information the XLSX cell carries (e.g. `00123` entered as text)
does not reach the sniffer and may be inferred as a number. The same happens with CSV and
is fixed by ii-c's settled types. Whether to pass cell types as initial `types` is decided
in the implementation spec.

The intermediate CSV is a working file of the interpretation and is not kept.

### 5. XLS (legacy format) is out of scope for now

Few parsers read the BIFF-format XLS (only SheetJS), and its share in published data is
falling. Revisit if Step 0 measures a high share.

### 6. Branch on the version's schema, not on format

Today the table preview, indexing, the AI abstract and suggestion materials
(`suggest/materials.ts`) branch on `isCsvFormat`. An XLSX is a table in some versions and
not in others, so **for XLSX the branch must be "does the version have a schema"**.

- Preview: a table if there is a schema, otherwise the Office Viewer (whether both can be
  toggled is a UI decision)
- Full-text index: unchanged — the officeparser text
- AI abstract: with a schema it could move to the table material (ADR-053 §3, "pass the
  original only when the content cannot be obtained otherwise"). Whether to do so is decided
  separately

### 7. AI proposal and human settlement (Step 3)

For versions that failed the rules, AI proposes a table range, triggered by an editor's
action (not automatically).

- Input: top-left N×M cell values and the merge map (not the whole original)
- Output: sheet name, data range (A1 notation), number of header rows
- Check: apply conditions 2–4 of decision 2 to the proposed range. If it fails, it is not
  shown
- Settle: the range a person confirmed goes in `resource.column_settings` (the same place as
  the primary key and settled types; only a person writes it, never the worker)
- Apply: later versions are interpreted with the settled range. A version freezes the range
  it was created under. Settling or changing the range joins the inputs to version identity
  and creates a new version (the same treatment as ii-c's settled types, spec §6.5)

Multi-row headers are handled by a person giving column names when settling (AI can also
propose column names).

**With the same skeleton, a path where a person specifies the range without AI (Step 2) can
be built first.** The AI proposal merely helps fill that input.

## Stages

| Stage  | Content                                                                           | Prerequisite         |
| ------ | --------------------------------------------------------------------------------- | -------------------- |
| Step 0 | Measure, on real XLSX, the share meeting decision 2 and the `reason` distribution | None                 |
| Step 1 | Rules-only decision and conversion (decisions 1–6)                                | Step 0 results       |
| Step 2 | UI for a person to specify and settle a range, and applying settled values        | ii-c (settled types) |
| Step 3 | AI range proposals and their checking                                             | Step 2               |

Step 0 is a measurement that only runs the decision, without shipping code; the parser
choice (table above) is made here too. If the share is low and failures skew toward "a few
title rows", widening the Step 1 rules is enough. If multi-row headers or multiple tables
dominate, the value of Steps 2 and 3 becomes clear.

## Consequences

- `apps/worker/src/pipeline/steps/interpret.ts` gains an XLSX branch (one more parser
  dependency)
- `resource_version`'s `reason` gains XLSX-derived values
- Places branching on `isCsvFormat` that handle XLSX, such as the table preview and
  suggestion materials, change to branch on the version's schema
- Lake, OData and MCP look at the Parquet and schema, so no changes are expected there
- Existing XLSX versions get the new interpretation on re-interpretation; the canonical
  object does not change. The path to re-interpret existing versions in bulk is decided in
  the implementation spec
- From Step 2: `column_settings` gains the table range, and version identity gains an input

## Open issues

1. **Parser choice** (Step 0)
2. **Hidden rows and columns**: they exist as values, so including them seems the right
   default, but some files merely hide working columns. Decide after seeing examples in
   Step 0
3. **Choosing among multiple sheets**: decision 2-1 is limited to "exactly one table".
   Choosing one sheet out of several can be handled by the Step 2 settled value, but
   producing several tables from one resource changes the one resource = one table premise
   and is a separate decision
4. **Size**: XLSX is ZIP-compressed, so it expands far beyond the 100MB entry limit.
   Whether XLSX needs its own interpretation limit is decided from the Step 0 measurements
5. **Preview toggle**: whether an XLSX interpreted as a table keeps a toggle to the Office
   Viewer

## Related ADRs

- ADR-029: Automatic column type inference for CSV/TSV preview Parquet (type inference rides
  the CSV interpretation)
- ADR-032: MCP data query platform (as a table, it rides `/query`)
- ADR-040: AI metadata suggestions (the "a suggestion, not a decision" stance)
- ADR-043: Resource versioning and row-level diffs (rides layer 2; where settled values live
  and version identity)
- ADR-046: Settling the canonical object, separate from its interpretation (makes open
  issue 5 concrete for XLSX)
- ADR-048: Modeless table preview (uses the table preview as is)
- ADR-053: AI-generated resource abstracts (answers the §2 cost with a different skeleton)
- ADR-055: Table data access from BI tools (as a table, it rides OData)
