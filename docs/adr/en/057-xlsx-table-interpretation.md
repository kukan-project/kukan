> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/057-xlsx-table-interpretation.md`](../jp/057-xlsx-table-interpretation.md).

# ADR-057: Interpreting Excel Tables as Tables (Reading Instructions Are Settled Values; Only Plain Tables Are Automatic, AI Only Proposes)

## Status

**Proposed — the ratios on public data (Context 5) and how often the proposals of the rules and of AI are right (Context 7) have been measured. A person has checked half of the answers (54 sheets). Whether to widen what is automatic is decided after the convention for one table or several (Open issue 5) is settled**

A sheet of an Excel file (XLSX, XLS) is interpreted as a table in the Interpret stage, producing
a preview Parquet just as CSV/TSV do. From there it rides the table preview, row-level diffs
(ADR-043 layer 2), OData (ADR-055) and MCP `/query` (ADR-032) unchanged.

Which part of which sheet is read as a table is expressed by **reading instructions** (sheet,
table range, number of header rows, column names). Interpretation is deterministic from the
reading instructions.

- A **"plain table" — a single header row over rectangular data** — gets its reading instructions
  from the rules and becomes a table automatically
- For any other table (a statistical table with a multi-row header, for example), the rules make
  a **proposal** of reading instructions, and a person checks it and saves it as a settled value.
  Until it is settled, no table is made
- AI does not decide. It is limited to making a proposal of the same shape as the rules', and to
  saying that a sheet should not be read as a table. Its proposals are checked by the rules. In
  the measurement AI's proposals were right more often than the rules' (Context 7), so on a site
  that configures AI they are shown from the start, beside the rules' proposals

The canonical object (the uploaded Excel bytes) is untouched. The Parquet is a product of
"interpretation" in the sense of ADR-046.

This ADR makes concrete, for Excel structure detection, open issue 5 of ADR-046 (making the
producer of an interpretation a replaceable slot). It also answers, with a different skeleton,
the cost ADR-053 §2 stated explicitly: "Excel does not become usable as data."

The original proposal covered only plain-table XLSX, left the parser undecided and put XLS out of
scope. After the measurement on public data (Context 5), it now centres on reading instructions,
includes XLS, and settles the parser as the in-house reader.

## Context

### 1. Today, Excel does not enter the table path

Interpret branches on `isCsvFormat` (`apps/worker/src/pipeline/steps/interpret.ts`), and
XLSX/XLS are not interpreted as tables. As a result:

| Path                     | CSV/TSV                                       | XLSX/XLS                                         |
| ------------------------ | --------------------------------------------- | ------------------------------------------------ |
| Preview                  | Table (Range delivery + DuckDB-WASM)          | The original drawn, and extracted text (ADR-065) |
| Column schema            | Recorded per version                          | None                                             |
| Row-level diff (layer 2) | Yes (changed-row tracking with a primary key) | None                                             |
| OData / MCP `/query`     | Yes                                           | None                                             |
| Full-text index          | The table's text                              | The text of the sheets' rows                     |
| AI summary (ADR-053)     | Table material                                | The original is passed as is                     |

In municipal open data it is not rare for a table to be published only as Excel. The catalog can
say what the data is about, but the data cannot be worked with.

### 2. Whether something is a table depends on the content, not the format

CSV is a table by its format. Excel is not. Under one extension there are:

- plain tables, a single header row over rectangular data
- tables with a title and a unit note above, and sources and notes below
- statistical tables with multi-level headers, merged cells and subtotal rows in the middle
- forms, application templates and charts, which are not tables at all

So "Excel means table" does not hold, and **"it was a table / it was not (and why)" must be
recorded as the interpretation result of each version**. CSV already has this mechanism —
`resource_version.schema` holds an empty schema (`NO_TABLE`) and a `reason` (`no-columns`,
`too-many-columns` and so on) to say "interpreted, but there was no table".

### 3. Misjudging the structure is a data-integrity problem, not a UX problem

ADR-053 §2 put it this way: **if the header row is judged one row off on a rerun, the row-level
diff reports every row as changed.** A wrongly read range mixes note rows into the data, which is
then served by OData and enters MCP aggregates.

Wrongly making a table does far more harm than failing to make one. Failing to make one only
leaves today's handling (the original drawn, and the text index) in place. The automatic judgement
must lean towards **not treating a sheet as a table when in doubt**.

### 4. Parts already in place

| Part                             | What it is                                                   | Use in this ADR                                                     |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| XLSX reader                      | `interpret/document/document-text.ts` (streamed ZIP and XML) | Widened to read the grid of cells (Decision 8)                      |
| XLS reader                       | `interpret/document/legacy/xls.ts` (BIFF records)            | Same                                                                |
| CSV interpretation               | `interpretCsv` in `interpret/table/csv.ts` (DuckDB sniffer)  | The table range is written as CSV and passed to it (Decision 6)     |
| Title-row detection              | `countTitleRows` in `interpret/table/csv-title-rows.ts`      | Drops single-cell rows above the table                              |
| Footer removal                   | `trimFooter` in `interpret/table/csv.ts`                     | Drops sources and notes below the table                             |
| Record that there was no table   | `NO_TABLE` + `reason`                                        | Keeps the reason a sheet missed the rules                           |
| Column settings a person settled | `resource.column_settings` (primary key, settled types)      | Holds the settled reading instructions (Decision 2)                 |
| Freezing into the version        | A version freezes the settings at creation (spec §6.7)       | The settled reading instructions are frozen too                     |
| Version identity input           | `sameVersionIdentity`                                        | Settling reading instructions makes a version (as settled types do) |

Excel reading already exists in-house, for extracting document text. Today it reads only cell
values, and writes each row as the text of its non-empty cells packed from the left. It does not
read a cell's column, merges, formats or hidden state.

### 5. Measurement of published government Excel files (2026-11)

From 27 sites — the national data portal, prefectural and municipal catalogs, and statistics
sites — 120 XLSX files (790 sheets) were collected, measured mechanically and sorted into types.
The sorting was automatic; 60 sheets were checked by eye (52 were right). The ratios carry an error
of about ±5 points.

| Type                                                                                 | Share of workbooks |
| ------------------------------------------------------------------------------------ | ------------------ |
| A Plain list (one header row, rectangular)                                           | 25%                |
| B List with a title and notes (A once top and bottom are removed)                    | 8%                 |
| C Statistical table with a hierarchical header (multi-row header, hierarchical stub) | 55%                |
| D Several tables on one sheet                                                        | 8%                 |
| E Forms, F documents, covers and tables of contents                                  | 4%                 |

What it showed:

- **25% of the workbooks pass the original "plain table" conditions.** It splits widely by source:
  2 of 66 on the national data portal, 18 of 21 in one municipal catalog. 15 of the latter share
  one template; without them the overall figure is 14%
- **Most misses are "multi-row header" and "several sheets".** Of the 56 single-sheet workbooks
  that miss, 38 have a multi-row header; 34 workbooks (28%) have several sheets. "Just a few title
  rows above the table" is rare, and widening to B only reaches 33%
- **Half of the multi-sheet workbooks line up same-shaped sheets by year or region** (14% overall)
- **No formula without a cached result was found**
- **12% of the table sheets leave column A empty and start at column B**
- **Structure set in Excel gives candidates for where the header ends.** Frozen panes are in 24%
  of the workbooks, an autofilter in 18%, print titles in 18%. The frozen row matched the estimated
  end of the header in 71% of cases. But these are mostly on type C, and they are not accurate
  enough to settle on. Excel tables (ListObject) were in only 3 workbooks, and a print area mostly
  just covers the whole used range, so it is no cue for the table range
- **XLS is not rare.** On the national data portal 4,727 datasets have an XLS and 1,839 an XLSX.
  In some municipal catalogs XLSX is the larger. But three in ten resources a catalog labels XLS
  were XLSX inside, so these counts overstate XLS

The sample was drawn with equal numbers per ministry, so ministries with many datasets weigh less
than they really do. Large statistical tables such as prefectural yearbooks are hardly in it.

99 XLS files were then collected and measured the same way. **XLS is more broken than XLSX.**

| Per workbook                             | XLSX (120) | XLS (99) |
| ---------------------------------------- | ---------- | -------- |
| Passes the plain-table conditions        | 25%        | 2%       |
| C Statistical table, hierarchical header | 55%        | 75%      |
| Has merged cells                         | 62%        | 83%      |
| Several non-empty sheets                 | 28%        | 43%      |

Bringing XLS into scope adds almost nothing that becomes a table automatically. What it adds is
tables for a person to settle. XLS is not only old publications: 38 of the files were last saved
in 2020 or later.

### 6. Rules and prior research to draw on

- Japan's Digital Agency publishes the "Rules on Machine Readability of Administrative Data"
  (March 2026) and a tool that checks violations by rules. The tool estimates a table's range, its
  header rows and its stub columns from blocks of non-empty cells. Its documentation says it is
  weak on multi-row headers, tables split by empty rows and tables placed side by side. Its
  vocabulary of total rows and no-value marks is a starting point for writing rules. The same
  rules state that when item names are split over several rows, telling the columns apart needs
  the complete item name that combines those rows (L2-03)
- These rules are a standard for those who make the data, not a standard for a reader's
  judgement. Some tables violate them and can still be read (a title row falls under L3-01, but
  the table reads once it is dropped), and neither the table range nor the number of header rows
  follows from the rules. What they offer is backing for the plain-table conditions and words for
  telling why no table was made (Decisions 3 and 5)
- The Ministry of Internal Affairs and Communications' "Unified Rules on Notation for
  Machine-Readable Data in Statistical Tables" (December 2020) lists the same kind of obstacles
  for statistical Excel tables (merged cells, several tables on one sheet, split data and so on)
- In research that has an LLM answer the table range (SpreadsheetLLM, 2024), the F1 for exactly
  matching boundaries was 0.41 without fine-tuning and 0.79 with it. Passing the sheet
  uncompressed dropped it to 0.15, and adding fills and borders as text made it worse. Values for
  current models have not been checked

### 7. Results of the spike (2026-11)

112 sheets (70 XLSX, 42 XLS) were drawn by type from the sample of Context 5, and the right
reading instructions (Decision 2) were labelled for each. 110 were tables. A prototype of the
rules, and AI asked for a proposal of the same shape, were compared with these answers. A "match"
means the four edges of the range and the number of header rows are all the same.

**The answers were labelled by AI looking only at a display of the cells; no person has checked
them.** The rules were tuned on half of the answers. AI's proposals are compared with answers
labelled by a model of the same family. Both sets of figures are taken to be on the high side
until checked against answers a person labelled. A person has since checked 54 sheets ("Checked by
a person" below). The table right below is against the answers before that check.

| Sheets that match (of 110)                    | Rules    | AI (small model) | AI (large model) |
| --------------------------------------------- | -------- | ---------------- | ---------------- |
| All                                           | 86 (78%) | 99 (90%)         | 100 (91%)        |
| XLSX (70) / XLS (40)                          | 59 / 27  | 63 / 36          | 63 / 37          |
| A Plain list (15)                             | 15       | 15               | 15               |
| B List with a title and notes (19)            | 17       | 18               | 19               |
| C Statistical table, hierarchical header (56) | 43       | 51               | 51               |
| D Several tables (20)                         | 11       | 15               | 15               |
| The header band alone matches                 | 96 (87%) | 108 (98%)        | 107 (97%)        |

On the rules:

- On the half not used for tuning, 33 of 43 sheets (77%) matched
- Using one cue alone, the first data row was right for the sequence of row types in 95%, print
  titles 89%, frozen panes 78%, the autofilter 67%, and the shape of merges in the header band
  55%. Print titles were right on 8 of 9 XLS sheets too. The autofilter's last row was right in
  only 33%
- On 48 sheets (44%; 57% of C) the sequence of row types and another cue agreed, and the first
  data row was right on all 48. The whole range matched on 42. The misses were the bottom and
  right edges (several tables, a folded table) and the top of the header
- Frozen panes agreeing with print titles confirms nothing: both are the same author's settings

On AI:

- What was passed: the first 35 rows, the last 10 and the sparse rows in between (the first 14
  columns and the last 2, cells cut at 12 characters), the number of non-empty cells per row, the
  merged ranges and the Excel settings. One call per sheet
- **The size of the model made almost no difference.** The two models gave the same answer on 100
  of the 110 sheets. Varying the amount of reasoning on the small model gave 97 matches (less), 99
  (default) and 100 (more), while the time taken spread by a factor of 1.7
- Adding facts counted over the whole grid (non-empty cells and row extent per column, the blocks
  split by empty rows, the headers of the columns not shown) moved the matches from 99 to 100 and
  left the right and bottom edges as they were. The remaining errors are less about what is not
  shown than about how far one table is read to extend
- AI's errors gather at the right and bottom edges — what the passed text does not show. On 28
  sheets, letting the model fetch the rows and columns it needs raised the matches from 24 to 27
  for the large model and from 24 to 25 for the small one
- **The rules and both models all gave the same answer on 78 sheets (71%), and 77 of those matched
  the labelled answer.** On the 10 sheets where the two models differed, at least one was wrong
- Of the 6 sheets every model missed, 4 were ones the labeller was unsure about too. They are
  questions of convention — one table or several, and whether a rightmost column with no header
  belongs
- Asked to write the table itself as CSV for small tables (8 sheets of up to 1,300 cells), every
  value in the rows written equalled the source cell (661 rows and 6,189 values over the two
  models). But the sample's sheets average 5,600 cells and some exceed 10,000 rows, which cannot
  be written out

Checked by a person:

- One person checked 54 sheets in two rounds. The first round covered the 35 sheets where the
  proposals differed and 8 where the rules and both models gave the same answer, on a screen
  showing only values and merges. The second covered 11 sheets with several blocks that had not
  been checked and 5 from the first round, on a screen that draws the borders by line style and
  shows merged cells as merged
- The answers labelled by AI differed from the person's on 8 of the 43 sheets in the first round
  and 1 of the 11 in the second. On 5 of the 8 the rules' proposal matched the person, on 2 the
  small model's. The 2 sheets labelled as not a table were read as tables by the person
- **A person needs the borders to judge.** Of the 5 sheets judged again with borders, the answer
  changed on 2 and became "cannot decide" on 1. The person said that some sheets cannot be decided
  on a screen of values and merges, and that borders are required for a person's judgement
- With the person's answers in place and the 1 undecided sheet left out, the matches over 111
  sheets are 89 (80%) for the rules, 97 (87%) for the small model and 96 (86%) for the large one.
  The rules and the small model gave the same proposal on 82 sheets, 79 of which match. Where the
  rules and both models agreed (78 sheets), 76 match. The other 58 sheets still carry the answers
  labelled by AI
- The person's answers follow this convention. Blocks with their own title or name (per court
  instance, per table number, per category) are separate tables even with the same columns, and
  only the first is read. Groups of rows inside one table (prefectures, then designated cities), a
  header repeated per page and notes at a page break are inside one table. A table whose columns
  are folded sideways for printing is one table over the whole width. Separate tables side by
  side that share row labels (a balance sheet) are read on the left only. Layouts where the rows
  continue in a column block to the right were answered both ways (first block only on 2 of 3
  sheets, the whole on 1)
- **Folded and multi-column layouts have no right answer.** The person said that at this point
  even a person cannot judge. Taking the whole puts the row-label column or the header in the
  data again; taking the left part drops the remaining rows or columns. No choice of a range and
  a number of header rows gives a correct table
- **Borders did not work as a mechanical cue for the range.** The rectangle around the bordered
  cells matched the person's answer on all four edges on 9 of the 43 first-round sheets (left 36,
  right 29, top 25, bottom 18). Titles and notes have lines too, and so do other tables. Giving
  the small model the position and style of the lines as text lowered the matches from 97 to 86:
  the top edge moved to the title row and the bottom to the notes. This points the same way as
  the prior work in Context 6
- Telling the small model that "blocks stacked with the same columns are one table" lowered its
  matches from 97 to 91. The person read named blocks as separate tables

By shape. From the person's notes and the notes written with the answers, the sheets whose shape
one rectangle cannot express (header or notes coming again inside the range, columns folded
sideways, column blocks) were marked: 11 of the 111. No person has checked the marks.

- On the 100 expressible sheets the matches are 86 for the rules, 89 for the small model and 91
  for the large one. The rules and the small model gave the same proposal on 78 sheets, 77 of
  which match
- Telling the sheets that are "not one plain table" (several tables, or a shape that cannot be
  expressed: 27 sheets) was measured. A rule (a header row comes again below or to the right)
  named 17, all correctly. The small model, asked for the shape, named 27: 24 correctly, and 3
  plain tables by mistake. Both missed 3, two of which are sideways folds with the row-label
  column written again to the right
- **Of the 84 sheets neither named, the rules and the small model gave the same proposal on 70,
  and all 70 match.** That is 63% of all sheets

Other findings:

- **Hidden rows and columns were almost always part of the table.** Of the 19 workbooks that had
  them, 11 had content there: in 10 it was part of the table (earlier periods, a code column, a
  breakdown) and in 1 a row of check sums
- **Column names joined from a multi-row header were free of duplicates on 13 of 36 sheets.** Nine
  in ten duplicates come from one merge with no children spanning several columns
- The grid reader (Decision 8) read 120 XLSX files (790 sheets, 4.43 million cells) in 7.2 seconds

## Options considered

### Who decides

#### A) Let AI decide

Pass the original (or the top-left N×M cells and a merge map) to a model and have it answer
"is it a table, and if so which range and how many header rows". It copes with broken tables, so
the share picked up as tables is the highest.

**Not adopted.** Nothing guarantees the same answer from the same input, which breaks the
pipeline's determinism (ADR-046). When it returns a plausible error there is no mechanical way to
detect it. In a closed network (`AI_TYPE=none`) the whole feature would be unavailable. And
judging a plain table can be verified by rules from the grid of cells — handing it to AI adds cost
and non-determinism without adding accuracy (in the measurement too, the rules and AI both matched
all 15 plain lists). For tables that are not plain, AI's proposals were right more often, but one
in ten still missed (Context 7). A missed proposal that became a table as is would do great harm
(Context 3). The accuracy is not something to rely on alone.

#### B) Decide by rules only

Check merged cells, the number of header rows, rectangularity and how column types line up,
mechanically from the grid of cells. Deterministic, explainable, and the same in a closed network.

**Enough for plain tables, but it does not reach the majority.** In the measurement, rules alone
can automate 25–33%, and almost nothing from national data passes.

#### C) Rules make proposals, only plain tables are automatic, a person settles the rest; AI adds proposals — adopted

- Only what passes the plain-table conditions becomes a table automatically (as in B)
- For the rest, the rules make a proposal of reading instructions, and a person checks and
  settles it
- AI makes proposals of the same shape as the rules'. Its proposals are **checked** by the rules
- What is settled is saved as a settled value, and interpretation from then on is deterministic
  from it

What is kept is a decision, not an inference, so reruns do not drift. It is the same skeleton as
ADR-040's "a proposal, not a decision" and ADR-053 §2's "proposal → human confirmation →
persisted as a settled value". In a closed network only the AI proposals are missing; the rules'
proposals and a person specifying the range remain.

### Whether to read multi-row headers automatically

Automating the measured majority (C) would have the largest effect. **Not for now.** One header
row off shifts every row (Context 3).

Two ways of widening are in sight (Context 7).

- Within the rules, when the sequence of row types and another cue agree. That covers 44% of
  sheets, and the first data row was always right. The whole range missed on one sheet in eight
- When the rules' proposal and AI's proposal agree. That covers 71% of sheets, and 99% matched the
  labelled answer. It is limited to sites that configure AI

Both are figures on 110 sheets whose answers AI labelled. They are checked against answers a
person labelled, the share of cases where the rules' proposal and the person's settled value agree
is recorded, and the judgement is made later. Until then an agreeing proposal is only shown as a
"likely" proposal.

### The parser that reads Excel

Judging needs **cell positions and merged-cell information**. Converting needs values and types.

| Candidate                            | Merged cells       | Notes                                                                                                 |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------- |
| Widen the in-house reader            | Available if added | Streaming and limits already exist. Reads XLS too. No new dependency                                  |
| DuckDB excel extension (`read_xlsx`) | Not available      | Only usable for reading once the range is known. Cannot read XLS                                      |
| exceljs                              | Available          | Cannot read XLS                                                                                       |
| SheetJS (xlsx)                       | Available          | Reads XLS too. The npm registry version is old; distributed from its own CDN (a separate supply path) |
| ibisOffice (ADR-065)                 | Not available      | The bundled WASM only draws; it has no way to hand out cells or merges. Does not run in Node.js       |

**Widen the in-house reader** (Decision 8). The choice was left open at first because there was no
part that read Excel. Since then, in-house readers for XLSX and XLS were added for document text
extraction. What is added is reading more attributes within the same frame; memory use and the
limits (such as on ZIP expansion) do not change.

## Decision (proposed)

### 1. The canonical object stays Excel. The Parquet is a product of interpretation

Excel is not converted to CSV to replace the canonical object. Only versions interpreted as tables
get a preview Parquet and a schema. If the interpretation rules change later, the canonical object
does not, and reinterpretation follows.

### 2. Reading instructions

Where to read as a table is expressed by these values.

| Item         | Content                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| Sheet        | The sheet's name                                                                   |
| Table range  | The rectangle including the header (A1 notation). Titles and notes stay outside it |
| Header rows  | How many rows from the top of the range are the header                             |
| Column names | Names that replace the ones made from the header (optional)                        |

The rules, AI and people all produce this same shape. The only difference is who produced it.

- For a plain table (Decision 3) the instructions the rules produce are used as they are. They are
  not saved (the rules give them every time)
- Otherwise the instructions a person settled go in `resource.column_settings` (the same place as
  the primary key and settled types; only people write it, the worker does not). Later versions
  are interpreted by the settled instructions. A version freezes the instructions at creation.
  Settling or changing them joins the version-identity input and makes a new version (as settled
  types do, spec §6.5)
- What to do when settled instructions no longer fit a new version's content (no header in the
  range, a changed number of columns and so on) is decided in the implementation spec, along the
  lines of the review after a type change is taken in (spec §8)

**Reading instructions do not change the table's shape.** The cells in the range are read in the
rows and columns they were written in (Decision 7).

### 3. Conditions for a "plain table" that becomes a table automatically

When all of the following hold, the rules decide the reading instructions and the sheet is read as
a table.

1. **Exactly one sheet can be seen as a table.** The other sheets are empty or clearly not tables
   (a cover with very few cells, a chart-only sheet and so on). This keeps the premise of versions
   and the Lake that one resource is one table
2. **No merged cells in the data range.** Merges outside it (a title above) are allowed if they
   can be dropped as title rows
3. **The header is one row**, every header cell is filled, and none repeats
4. **The data is rectangular** — no values outside the header's columns
5. Title rows and note rows can be put outside the range by rules of the same idea as CSV's
   (`countTitleRows` / `trimFooter`). The rules apply where the range is decided and are not
   carried into the CSV interpretation (Decision 6)

Leading empty rows and columns are skipped (the table need not start at A1). The details (empty
rows, the threshold for "clearly not a table") are decided in the implementation spec.

These conditions overlap with items of the Digital Agency's "Rules on Machine Readability of
Administrative Data" (Context 6). A sheet that meets the conditions meets these items.

| Condition                                     | Item of the rules                                                   |
| --------------------------------------------- | ------------------------------------------------------------------- |
| One table on one sheet                        | L1-02 No more than one table on a sheet (file)                      |
| Rectangular data, no values outside the range | L1-03 Data is not split; L1-04 no information unrelated to the data |
| Every header cell is filled                   | L1-05 Every column has an item name whose meaning can be guessed    |
| No merged cells in the data range             | L1-12 Cells are not merged                                          |
| The header is one row with no repeats         | L2-03 Each column has a uniquely identifiable item name             |

Some things the rules ask for are not made conditions. A title row (L3-01) is dropped and the table
read. Formulas (L2-06) are read when they have a cached result (Decision 6).

### 4. For tables that are not plain, the rules make a proposal and a person settles it

For a sheet that misses the conditions, the rules make a proposal of reading instructions. The
proposal is not made into a table; it is shown to the editor.

Cues for making the proposal, in the order of strength measured (Context 7):

1. The sequence of row types — the switch from rows of text only to rows holding numbers or dates.
   This is the axis
2. Structure the author set in Excel — print titles, frozen panes, the autofilter. They join the
   vote on the first data row; the autofilter's last row is not used. Excel tables were in only 3
   workbooks of the sample and are not a cue (implementation spec §8.1)
3. The shape of merges in the header band — a horizontal merge over several children is a
   hierarchy; a full-width merge is a title. Weak alone; used to confirm 1
4. Words for totals, notes and units

A proposal on which the sequence of row types and another cue agree is shown as a likely proposal.
On a site that configures AI, AI's proposal (Decision 11) is shown beside it from the start, with
whether the two agree.

A multi-row header becomes one column name per column by joining parent and child headers from the
top. A merged cell's value is given to every column in its range. Joined names that collide are
made unique with a number (most collisions come from a merge with no children spanning several
columns). The joined names are a proposal and a person can change them (the "column names" of the
reading instructions).

Whether the proposal and the value the person settled agree is recorded. The share of agreement is
material for deciding whether to widen what is automatic (see "Whether to read multi-row headers
automatically").

### 5. When no table is made, today's handling stays and the reason is recorded

A version that is not automatically a table and has no settled instructions is `NO_TABLE`, with the
missed condition in `reason` (for example `merged-cells`, `multiple-sheets`, `multi-row-header`,
`multiple-tables`, `not-rectangular`, `form`). The preview stays the original drawn, and the
full-text index stays as it is. **Failing to make a table is not a failure; it is the
interpretation result that there was no table.**

The dashboard shows `reason` to editors as "why this was not read as a table". `reason` is kept in
words that do not depend on a country. In the display for Japan, the ID of the Digital Agency's
rule is attached where one corresponds (L1-12 for `merged-cells`, L1-02 for `multiple-tables`,
L2-03 for `multi-row-header`, L1-03 and L1-04 for `not-rectangular`). The rules' documents say how
to fix each, so it gives those who make the data a lead for fixing it. The correspondence lives in
the display layer and is not part of the judging rules.

### 6. Conversion goes through CSV to the existing CSV interpretation

The table range is written to an intermediate UTF-8 CSV and passed to `interpretCsv`.

- The first line of the intermediate CSV is the column names: the names joined from the header
  band (Decision 4), or the ones a person changed. The rows of the header band themselves are not
  written. From the second line on come the first data row through the last row of the range
- **Where the table is has already been decided by the reading instructions. The CSV
  interpretation does not infer the structure again.** It does not scan for title rows (no rows
  are skipped), the first line is declared the header, and the trailing notes are not inferred.
  That inference takes a sparse row at the end for a note, so it can drop a row that holds only
  "Total" and an amount at the end of a wide table. An option that turns it off is added to
  `interpretCsv`

- Cells are written as **raw values, not display formats** (`1234`, not `1,234`). Display strings
  with number formats applied are not produced
- Cells formatted as dates are written as ISO 8601 (not left as serial numbers; the 1900 leap-year
  quirk and the 1904 base are absorbed here). Japanese-era formats are written the same way, since
  the value is a date
- Formulas are written as their **cached results**. If the range has a formula with no cached
  result, the sheet is not treated as a table (`reason: 'uncached-formulas'`)
- A merged cell gives its value to every column of its range in the header (Decision 4); in the
  data only the top-left cell holds the value
- Hidden rows and columns inside the range are included. In the measurement they were almost
  always part of the table (Context 7). A person leaves a column out by the range

CSV is the route because type inference, applying settled types (`read_csv`'s
`types` declaration, spec §6.3), no-value marks and numbers written as text are all implemented in
one place, the CSV interpretation. An Excel-only route would split them in two.

The cost is that type information a cell carries (a `00123` entered as text) does not reach the
sniffer and may be inferred as a number. This happens with CSV too, and settled types fix it.
Whether to pass cell types as initial `types` is judged in the implementation spec.

The intermediate CSV is a working file of interpretation and is not kept.

### 7. What is not done

- **No conversion that changes the table's shape.** Turning wide into long, filling omitted values
  down, carrying a section row over as an attribute of the following rows, and joining two rows
  that make one record are all not done. They need the meaning to be read, and an error changes
  aggregates. The rows and columns are read as the author wrote them
- **Subtotal and total rows are not dropped.** No row inside the range is dropped. The notes below
  the table are left outside the range, not dropped by the CSV interpretation (Decision 6)
- **Forms, grid-paper sheets and documents are not read.** Only the reason is recorded
- **One resource does not yield several tables.** That would change the premise of versions and
  the Lake and is a separate decision. When one sheet holds several tables, a person can choose and
  settle one range. For the future, holding several tables in one resource as products derived
  from the one Excel, which stays the canonical object, is being considered. The schema, column
  settings, diffs, OData and the unit of search would become per table, and which table is the
  same table across versions would have to be decided, so it belongs to a separate ADR. So that
  the shape of the settled value need not change then, reading instructions are saved as a list
  of tables (one entry for now) and each table has a name. That a sheet holds other tables is
  recorded and shown to the editor

### 8. The in-house Excel reader is widened, and XLS is in scope

The current reader is made to produce a grid of positioned cells as well as the row text. Added:

- each cell's column and type
- merged-cell ranges
- from number formats, whether a cell is a date or text-formatted, and the date base (1900 / 1904)
- hidden sheets, rows and columns
- frozen panes, the autofilter range, print titles

Bold, fills and column widths are added if the spike shows they improve the proposals. The position
and style of borders are read. A person needs them to judge on the settling screen (Decision 10);
they are used neither as a cue for the rules nor as input to AI (Context 7).

XLS produces the same grid. XLS was first put out of scope because few parsers read it and because
its share in public data was expected to be falling. Neither holds now (Context 4 and 5). Print
titles are read for XLS too (three in ten XLS files have them, and they are often right). For XLS,
the autofilter is not read.

The row text for the full-text index does not change.

### 9. Branch on the version's schema, not on the format

Today the table preview, indexing, the AI summary and the suggestion material
(`suggest/materials.ts`) branch on `isCsvFormat`. An Excel file may or may not be a table per
version, so **for Excel the branch must be "does the version have a schema"**.

- Preview: a table if there is a schema, otherwise the original drawn (whether to let people switch
  between the two is a UI decision)
- Full-text index: stays the row text
- AI summary: with a schema it can move to table material (ADR-053 §3, "pass the original only
  when the content cannot be had otherwise"). Whether to move it is judged separately

### 10. The screen for settling

Reading instructions are settled in the dashboard's "Table settings" tab (ADR-072). They go into
the same draft as the primary key and settled types, and one apply makes one version.

The range is chosen on a simple table that shows the grid of cells the worker read (values,
merges and borders). The rules' or AI's proposal is shown as a frame, as the initial value. The original drawn
(ADR-065) is only shown alongside. Choosing a range on the drawn original needs the drawing part to
report the selection outward, which it does not do today.

A person cannot judge on a table of values and merges alone (Context 7). The simple table draws
the borders in the line styles of the file (thin, medium, thick, double, hair, dotted, dashed)
and shows merged cells as merged. Drawing lines of different weight as the same line makes the
reader misread the divisions. Selecting a cell shows its address and the extent of its merge, and
a selected range can be taken as the range of the reading instructions. On a screen of this form
a person could decide 15 of 16 sheets. Line colour, fills, bold and column widths are added when
they turn out to be needed.

### 11. AI proposals

On a site that configures AI, for a sheet that misses the plain-table conditions, AI makes a
proposal of reading instructions. It is shown to the editor beside the rules' proposal. It is only
a proposal; no table is made from it.

- Input: the first and last few dozen rows of the sheet and the sparse rows in between, as text
  with row numbers and column letters. Attached are the number of non-empty cells per row, the
  merged ranges, the Excel settings (frozen panes, print titles and so on), and facts counted over
  the whole grid (non-empty cells per column, the blocks split by empty rows). The rules' proposal
  itself is not passed (passing it would stop agreement with the rules' proposal from confirming
  anything). The whole original is not passed. One call per sheet
- Output: only JSON of a fixed shape. No values are generated

  | Field         | Content                                                     |
  | ------------- | ----------------------------------------------------------- |
  | `kind`        | `table` / `multiple-tables` / `form` / `document` / `other` |
  | `range`       | The table's range (A1 style). `null` when not a table       |
  | `headerRows`  | The number of header rows                                   |
  | `columnNames` | Proposed column names (optional; as many as the columns)    |

  With `multiple-tables`, `range` points at the first table (topmost, then leftmost)

- Shape check: the range is A1 style and inside the sheet's used range, the header rows are fewer
  than the range's rows, and the column names are as many as the columns. An answer that fails is
  discarded
- Check: how column types line up, and whether rows or columns of the same shape continue just
  outside the range, are applied to the proposed range. A proposal that fails is not shown
- Settling: as with the rules' proposal, a person checks and settles it

A small model is enough, and little reasoning (Context 7). The facts counted over the whole grid
are attached to tell the model that there are columns and rows it is not shown; an effect on how
often it is right has not been confirmed. Borders are not given: giving them lowered the matches. Letting the model fetch rows and columns repeatedly was right more often (27 of 28 sheets against
24), probably because it can read the continuation and judge whether it is the same table. It
takes many round trips, so it is not used for the first proposal. Using it as a second stage —
rereading only the sheets where the rules' proposal and AI's differ — is kept as a candidate (Open
issue 1).

AI is not asked to write the table itself. Once the reading instructions are settled, the values
are copied deterministically. A large table cannot be written out, and nothing guarantees the same
result from the same input.

Collecting data published as both CSV and Excel lets the CSV be the answer, which widens the
evaluation without a person's labour.

## Stages

| Stage  | Content                                                                                                                                                        | Depends on |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Step 0 | Measure the share of each type on public data — **done** (Context 5)                                                                                           | Nothing    |
| Spike  | Widen the reader to the grid of cells and measure, on a sample (XLS included), how often the proposals of the rules and of AI are right — **done** (Context 7) | Step 0     |
| Step 1 | The widened reader and automatic interpretation of plain tables (Decisions 1–3, 5, 6, 8, 9)                                                                    | The spike  |
| Step 2 | The rules' proposals, the screen where a person settles reading instructions, and applying the settled value (Decisions 4, 10)                                 | Step 1     |
| Step 3 | AI proposals and the check (Decision 11)                                                                                                                       | Step 2     |

Stacking same-shaped sheets into one table (the sheet name becomes a column) can be added later as
an item of the reading instructions. It is judged after Step 2, from how the feature is used.

## Consequences

- `apps/worker/src/pipeline/steps/interpret.ts` gains an Excel branch. No new dependency
- The Excel readers (`document-text.ts`, `legacy/xls.ts`) produce two outputs, the row text and the
  grid of cells
- `resource_version`'s `reason` gains Excel-derived values
- Of the places that branch on `isCsvFormat`, such as the table preview and the suggestion
  material, those that handle Excel change to branch on the version's schema
- The Lake, OData and MCP look at the Parquet and the schema, so no change is expected
- Existing Excel versions get the new interpretation on reinterpretation. The canonical object
  does not change. How to reinterpret existing versions in bulk is decided in the implementation
  spec
- From Step 2: `column_settings` gains reading instructions, and the version-identity input gains
  one item

## Open issues

1. **The condition for widening what is automatic**: agreement within the rules and agreement
   between the rules' proposal and AI's are both candidates (see "Whether to read multi-row headers
   automatically"). On the sample, 63% of the sheets met the condition "neither the rules nor the
   model names it as not one plain table, and the two proposals are the same", and all of them
   match (Context 7). Decided after a person checks the remaining answers and the condition is
   checked on another sample. Whether AI rereads a
   sheet where the proposals differ, fetching rows and columns itself, is decided with it
2. **Several sheets**: Decision 3-1 is limited to "exactly one sheet that can be seen as a table".
   Choosing one of several sheets is covered by reading instructions. Stacking same-shaped sheets
   is a later judgement (the note under Stages). One resource does not yield several tables
   (Decision 7)
3. **Size**: XLSX is ZIP-compressed, so against the 100 MB entry limit the expanded size is far
   larger. Whether Excel gets its own interpretation limit is decided from the spike's measurement
4. **Switching previews**: whether an Excel file interpreted as a table keeps a switch to the
   original drawn
5. **One table or several**: whether a repeated header, a table folded as a continuation, or
   blocks per section count as one table or several. The rules, AI and the labelled answers all
   split here. The 54 sheets a person checked suggest this convention: named blocks are
   separate tables; groups of rows inside one table, and a table whose columns are folded
   sideways for printing, are one table (Context 7). But for folded tables, multi-column
   layouts, and notes or repeated header rows inside the range, no choice of a range and a number
   of header rows gives a correct table. These are taken out of what is scored against a single
   answer and treated as "shapes one rectangle cannot express". Whether to give no proposal and
   show the reason (Decision 5), to add an unfolding option to the reading instructions, or to
   stack named blocks that would form one table with one more column is decided in the
   implementation spec
6. **Joining header names**: the separator, headers whose parent is shown by position alone, not
   by a merge, and whether adjacent equal names are merged
7. **Memory under the worker's conditions**: the grid reader's speed was measured, but not its
   peak under the worker's memory limit

## Related ADRs

- ADR-029: Automatic column type inference for CSV/TSV preview Parquet (type inference rides the
  CSV interpretation)
- ADR-032: MCP data query foundation (a table rides `/query`)
- ADR-040: AI metadata suggestions (the stance of "a proposal, not a decision")
- ADR-043: Resource versioning and row-level diffs (rides layer 2; where settled values live, and
  version identity)
- ADR-046: Separating settling the canonical object from interpreting it (makes open issue 5
  concrete for Excel)
- ADR-048: The single table preview (used as is)
- ADR-053: AI-generated resource summaries (answers the cost in §2 with a different skeleton)
- ADR-055: Table data access from BI tools (a table rides OData)
- ADR-065: Drawing the original of Office documents (the preview of Excel that did not become a
  table; shown alongside on the settling screen)
- ADR-072: Dataset editing in the dashboard (reading instructions are settled in the "Table
  settings" tab)
