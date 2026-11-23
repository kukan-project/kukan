# Phase Excel-Tables: reading Excel tables as tables — implementation spec

> **Goal**: read an Excel (XLSX, XLS) sheet as a table in the Interpret stage, and produce the
> same preview Parquet and schema as for CSV/TSV. From there it rides the table preview, row-level
> diffs, OData and MCP's `/query` as it is. **Where to read as a table is expressed by "reading
> instructions"; only plain tables are automatic by rules. Otherwise a person settles the rules' and
> AI's proposals.** ADR-057 is authoritative for design decisions.

> The Japanese version (`docs/specs/jp/phase-excel-tables.md`) is canonical. This is a reference
> translation.

## 0. What this spec decides

The matters ADR-057 left to the implementation spec, and this spec's answer.

| Matter                                                | Answer                                                                                              | Section |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| Shape and home of reading instructions                | A list of tables (one entry for now) in `column_settings.readings`                                  | §3      |
| The range when the version changes                    | Taken again for every version; plain-table judging redone too                                       | §3.3    |
| Details of the plain-table conditions                 | A procedure that drops a sheet on any single sign against it                                        | §5      |
| `NO_TABLE` reasons                                    | 14 added. One on the version, all that hit on the proposal                                          | §5.8    |
| The option added to `interpretCsv`                    | Do not infer structure (title-row scan, trailing notes)                                             | §6.2    |
| Whether cell types seed `types`                       | A column of text cells only is read as text                                                         | §6.3    |
| Re-interpreting existing Excel versions               | The layer-2 sweep picks them up. Counted before release                                             | §7.2    |
| The grid handed to the settling screen                | The worker makes it when the screen is opened                                                       | §8.4    |
| Joining column names                                  | Separator `_`, a part equal to the one above is not repeated                                        | §8.2    |
| When the settled header is not found in a new version | Read by rules if plain; otherwise no table, flagged for review                                      | §10.2   |
| When a plain table stops being plain after an update  | No table; flagged because the last version was a table. The last reading is offered as the proposal | §10.3   |
| The table while under review                          | The last version that was a table keeps being served, marked as old                                 | §10.4   |
| Shapes one rectangle cannot express                   | The first table's proposal, noted as possibly such a shape. No unfolding option                     | §8.3    |
| Size limit and worker memory                          | Keep today's 100MB. Measured within Step 1; a limit is added if exceeded                            | §4.3    |

## 1. Premises

- **ADR-057's spike is done.** How often the rules' and AI's proposals are right, the 54 answers a
  person checked and how borders work are in ADR-057 Context 7. The evaluation set lives outside the
  repository (§12)
- **Reading an XLSX sheet as a grid of cells lands in a separate PR** (`interpret/table/xlsx-grid.ts`).
  It returns each cell's position, type and raw value, merges, hidden rows and columns, frozen panes,
  the autofilter, print titles and borders
- **ADR-046**: interpretation is deterministic from a version's bytes. Reading the same version again
  gives the same answer
- **ADR-059**: heavy interpretation runs in the worker's child process (heavy). Reading an Excel grid
  runs there too
- **Versioning ii-c**: settled values (primary key, settled types) live in `resource.column_settings`,
  are frozen onto the version and are inputs to version identity. Reading instructions are treated
  the same way
- **ADR-072**: settling happens in the dashboard's "Table settings" tab, in the same draft as the
  primary key and settled types

## 2. Steps and PRs

| Step   | PR  | Content                                                                           | What users see                                     |
| ------ | --- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Step 1 | 1-a | XLSX grid (borders included)                                                      | Nothing                                            |
|        | 1-b | XLS grid (borders included)                                                       | Nothing                                            |
|        | 1-c | An option on `interpretCsv` not to infer structure (§6.2)                         | Nothing (CSV behaviour unchanged)                  |
|        | 1-d | Plain-table judging, intermediate CSV, Interpret branch, recorded reasons (§5–§7) | Plain Excel becomes a table; reasons are shown     |
|        | 1-e | Re-interpreting existing versions (§7.2)                                          | Existing plain Excel becomes a table too           |
| Step 2 | 2-a | Settled reading instructions, freezing onto versions, version identity (§3, §10)  | Nothing                                            |
|        | 2-b | The rules' proposal, the grid artifact (§8)                                       | Nothing                                            |
|        | 2-c | The settling screen (§9)                                                          | A person can settle a non-plain Excel into a table |
| Step 3 | 3-a | AI's proposal and checks (§11)                                                    | On sites with AI, AI's proposal is shown alongside |

1-b and 1-c do not depend on each other. 1-d builds on 1-a to 1-c. Step 2 starts after Step 1 ships.

## 3. Shape of reading instructions

### 3.1 Shape

```ts
/** One table read off a workbook (ADR-057 §Decision 2). */
interface TableReading {
  /** A name for the table, unique within the resource. Default: the sheet's name. */
  name: string
  /** The sheet, by name. */
  sheet: string
  /** Top-left corner of the range, header included (A1 notation). */
  from: string
  /** Bottom-right corner (A1 notation): of the version it was read on (§3.3). */
  to: string
  /** Rows from the top of the range that are header. */
  headerRows: number
  /** Names that replace the ones joined from the header, one per column. */
  columnNames?: string[]
  /**
   * Settled only: the header band's text, row by row, as it was when settled.
   * What finds the table again in a later version (§3.3).
   */
  header?: string[][]
  /**
   * Settled only: the one-cell row just above the header band (a table's name such
   * as "＜第一審＞"), when there is one. Tells apart tables with the same header (§3.3).
   */
  title?: string
}
```

- The rules, AI and people all produce this shape
- **Held as a list; one entry only for now.** As ADR-057 Decision 7 says, several tables from one
  resource belong to a separate ADR. An array from the start keeps the settled value's shape stable
  then
- `name` is the foothold for pointing at the same table across versions once there can be several.
  For now it is only displayed

### 3.2 Where it lives

| Place                                            | Written by   | Content                                                                                                   |
| ------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------- |
| `resource.column_settings.readings`              | People (API) | Settled reading instructions. **Absent is the ordinary state** (like key and types)                       |
| `resource_version.settled_reading` (new, jsonb)  | Worker       | A copy of the settled instructions when the version was created, frozen whether or not they could be used |
| `resource_version.reading` (new, jsonb)          | Worker       | The instructions the version was actually read with, and their source (`rules` / `settled`)               |
| `resource_version.reading_proposal` (new, jsonb) | Worker       | When the plain-table conditions are missed: the rules' proposal and the reasons hit (§8.3)                |

- A fifth input, `settledReading`, is added to **version identity** (`VersionIdentity`). On the
  version's side, `settled_reading` (the copy of the settled instructions at creation); on the
  resource's side, `column_settings.readings`. **It is not compared with the instructions actually
  read with (`reading`).** A version read by rules because the settled instructions were not found, or
  one that could not be made a table (§10.2, §10.3), still gets the copy. Otherwise the version's side
  would not match the settled instructions left on the resource, and every fetch of the same file would
  add another version (held the same way as settled types' `settled_types`)
- `name`, `from` and `to` are left out of the comparison: renaming does not change how bytes are read,
  and the range is taken again for each version (§3.3), so it may differ
- **Instructions the rules produced are not part of version identity.** The rules give the same
  instructions for the same bytes, so including them changes nothing, and it avoids every existing
  version becoming a new one when the rules are fixed
- Settled instructions, like settled types, are written to `column_settings` by the API's apply,
  and one version is added

### 3.3 The range is taken again for every version (decided 2026-11-23)

Some Excel files gain rows every month and are fetched again from the same URL. A range fixed by row
number means **the added rows are silently not read.** The right edge (a wide table that gains a year
column) is the same: "an error that persists". Even one more title row makes a fixed range mistake
the header.

**So the range is taken again for every version, and whether the sheet is a plain table is judged
again too.** Settled instructions hold not "which range" but "which table" and "how to read it".

| What settled instructions hold    | What is taken again for each version        |
| --------------------------------- | ------------------------------------------- |
| The sheet's name                  | The top edge (by finding the header band)   |
| The header band's text (`header`) | The left and right edges (the band's width) |
| The number of header rows         | The bottom edge (where the data ends)       |
| Column names                      |                                             |

A version is read in this order (§7.1).

1. With settled instructions, look for the header band's text on that sheet (compared after §5.7's
   normalization). When the settled instructions hold the table's name row (`title`), only places
   where the name just above the header band matches too count. **If two or more places match, no
   table is made and it is flagged for review** (on a sheet of tables with the same header, a
   changed order could read another table). If exactly one is found, it is the top; the left and right edges are the band's width; the
   bottom is where the data ends, decided as the rules' proposal does (§8.1). Read with the settled
   column names and number of header rows
2. If not found, or with no settled instructions, judge whether it is a plain table (§5). If plain,
   read it by rules
3. Otherwise no table (§10.2). If the last version was a table, it is flagged for review and the last
   table keeps being served (§10.3, §10.4)

**When settling, check that the range can be taken again.** The range a person chose is taken again on
that version by step 1, and the screen checks it comes out the same (§9). If it does not (the person
selected past an empty row in the middle, for example), the person adjusts the range or the header.
Settling a range that cannot be taken again would silently read a different range in the next version.

## 4. The grid of cells

### 4.1 XLSX

`xlsxGrid`, in a separate PR. Per sheet it returns the stream of rows (cells, borders) and, once
read, the layout (merges, hidden, frozen panes, autofilter).

### 4.2 XLS (PR 1-b)

`xlsSheets` in `legacy/xls.ts` is widened to return the same `GridRow` as `xlsxGrid`.

- Cell position and type: `LABELSST`, `LABEL`, `RSTRING` (text); `NUMBER`, `RK`, `MULRK` (number);
  `BOOLERR`; `FORMULA` (cached result; a text result is in the `STRING` record that follows)
- Dates: the format number from the cell's `XF`, and the `FORMAT` record's code through `dateKindOf`.
  The 1904 base from the `DATEMODE` record
- Merges: `MERGEDCELLS`. Hidden rows: `ROW`'s `fDyZero`. Hidden columns: `COLINFO`
- Frozen panes: `WINDOW2`'s `fFrozen` and `PANE`. Print titles: the built-in `NAME` `Print_Titles`
- Borders: the line styles in `XF` (4 bits × 4 sides). The style numbers map to the same 13 styles as
  XLSX
- Excel tables (ListObject) and the autofilter are not read (ADR-057 Decision 8)

### 4.3 Where and how far it is read

- The grid is read in the heavy child process. A new request, `read-grid`, is added
- **The limit stays as it is** (`MAX_PARQUET_SOURCE_SIZE`, 100MB). The grid reader already limits an
  XLSX's expanded size and merges (ZIP entries, `GRID_MAX_MERGES`)
- **Within PR 1-d, memory is measured under the worker's conditions.** The heavy child's peak RSS is
  taken for the sample's largest workbooks and synthetic 100MB XLSX and XLS files. If it exceeds the
  heavy limit (`HEAVY_PROCESS_MB`), an Excel limit (expanded bytes or cell count) is added
- Judging (§5) needs each row's cell count and types and some tens of rows above and below the table.
  **The whole grid is not held in memory.** The row stream is read once, keeping the counts judging
  needs and the candidate table's rows

## 5. Judging a plain table (Step 1)

**When in doubt, not automatic.** A wrong automatic table breaks every row when the header is off by
one, and row-level diffs report every row changed (ADR-057 Context 3). Missing a plain table costs one
settling by a person in Step 2. The procedure drops a sheet on any single sign against it.

### 5.1 Narrow to one sheet

Each sheet falls into one of these.

| Class       | Condition                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Empty       | No cell holds a value                                                                                                             |
| Not a table | A chart sheet; fewer than 20 cells with values; 60% or more rows are text in one cell or fewer, with fewer than 2 numeric columns |
| Hidden      | The tab is hidden (`hidden`, `veryHidden`). A sheet the author chose not to show is not a candidate                               |
| Candidate   | Everything else                                                                                                                   |

No candidate gives `no-table`; two or more give `multiple-sheets`. The thresholds follow the spike's
classifier and are checked in the evaluation (§12).

An encrypted workbook cannot be read at all; it misses with `encrypted`.

### 5.2 Decide the table's body, then check above and below it

Only skipping rows with one value or fewer from the top and bottom lets a title or note that uses two
cells or more slip into the header or the data. **The body is decided first, and what is outside it is
checked.**

1. Split the sheet into blocks at empty rows. The block with the most rows of two values or more is the
   candidate body. If two or more blocks tie, drop (`multiple-tables`)
2. If another block above or below the body has a row with two values or more, drop
   (`title-or-footer`). If it has only rows with one value or fewer, it goes outside the range as titles
   or notes
3. Inside the body, leading rows with one value or fewer are skipped as titles (titles with no empty row
   between). Trailing rows with one value or fewer are skipped as notes
4. Inside the body, the row after the titles is the header candidate (§5.3)
5. **Check the body's last row.** If, in a column whose data is 90% or more numbers or dates, the last
   row holds text (other than no-value marks), it is taken for a note or a total's caption with no empty
   row between, and the sheet is dropped (`title-or-footer`)

Merges in title rows are allowed. Merges below the titles (the header included) are handled in §5.4 and
§5.5.

**The error that remains.** In a table whose columns are all text (a list of facilities, for example),
a title as wide as the header sitting directly above it with no empty row cannot be told apart by type,
and is read as the header. §5.4's Excel settings (frozen panes, print titles) drop it when present. The
shape was not seen in the sample and is taken to be rare. If it happens, a person settling the reading
makes later versions read by the settled instructions (§3.3), so it can be recovered.

### 5.3 Take the header as one row

The row after the titles is the header. All of these are checked.

| Condition                                                                | Reason when missed |
| ------------------------------------------------------------------------ | ------------------ |
| Every header cell from the table's left edge to its right edge is filled | `header-blank`     |
| Normalized names do not repeat (§5.7)                                    | `header-duplicate` |
| Every header cell is text (no number, date or boolean)                   | `header-not-text`  |

A wide table with years as columns misses the third. That is fine: it is a statistical table and a
Step 2 case.

The table's edges are taken over the header and the data together. A row-label column under an empty
top-left header cell, or a note in the right margin, falls outside the header and so misses with
`header-blank` (and `not-rectangular`, §5.5).

### 5.4 Check that the header really is one row

Taking a second header row for the first data row is the most harmful error. Any one of these gives
`multi-row-header`.

- **Column types disagree**: the first data row is text in a column whose remaining data is 90% or
  more numbers or dates
- **A merge**: a merge touches the header row or the first data row
- **Excel's settings disagree**: the row of frozen panes, or the last row of print titles, differs
  from the header row (not checked when neither is set)

Excel's settings are not used as a cue for the range, only as a reason to drop. In the spike each was
right 70–90% of the time alone.

### 5.5 Check the data

From the first data row to the last:

| Sign                                                                     | Reason              |
| ------------------------------------------------------------------------ | ------------------- |
| A merge inside the range                                                 | `merged-cells`      |
| A value outside the header's columns (left or right)                     | `not-rectangular`   |
| A row with a value in one cell only (a section row)                      | `section-rows`      |
| 80% or more of the header row's text appears again below or to the right | `multiple-tables`   |
| A formula with no cached result                                          | `uncached-formulas` |

- Section rows (such as "〈資産の部〉") stay inside the range in Step 2; they are excluded from the
  plain-table conditions
- The repeated header is the rule that found 17 sheets with no false alarm in the evaluation. It
  signals several tables, a folded table, or a header repeated per page
- A table with empty rows in the middle is dropped for now. Rules cannot tell whether what follows is
  the same table or another. Data after an empty row misses by §5.2 steps 1–2 (`title-or-footer`, and
  also `multiple-tables` when the blocks are the same size)
- Hidden rows and columns are not a condition. Inside the range they are read (ADR-057 Decision 6)

### 5.6 Minimum size

Two columns or more, and one data row or more; otherwise `too-small`. A single-column table cannot be
told from title rows (the same reason as `countTitleRows`).

### 5.7 Normalizing header names

Before checking for duplicates and before writing them as column names:

- Leading and trailing spaces (full-width included) are removed. A line break inside a cell becomes
  one space
- Letters, digits and symbols are folded to half-width by NFKC (for comparison only; column names are
  written as in the cell)
- For duplicates, ASCII letters compare without case (`ID` and `id` are one name). DuckDB compares
  column names without case and renames the column that collides

### 5.8 Reasons

These are added to `NoTableReason` (`resource_version.no_table_reason`, varchar(32)).

| Reason              | Meaning                                                              | Digital Agency rule |
| ------------------- | -------------------------------------------------------------------- | ------------------- |
| `encrypted`         | The workbook is encrypted (a password to open), so it cannot be read |                     |
| `no-table`          | No sheet is a table candidate                                        |                     |
| `multiple-sheets`   | Several sheets are table candidates                                  | L1-02               |
| `title-or-footer`   | Above or below the table, a row that is not a title or a note        | L1-04               |
| `header-blank`      | The header has an empty cell                                         | L1-05               |
| `header-duplicate`  | Header names repeat                                                  | L2-03               |
| `header-not-text`   | The header has numbers or dates                                      |                     |
| `multi-row-header`  | The header is two rows or more                                       | L2-03               |
| `merged-cells`      | A merge inside the range                                             | L1-12               |
| `not-rectangular`   | Values outside the header's columns                                  | L1-03, L1-04        |
| `section-rows`      | A section row in the middle of the data                              |                     |
| `multiple-tables`   | Several tables on one sheet (the header repeats)                     | L1-02               |
| `uncached-formulas` | A formula with no cached result                                      | L2-06               |
| `too-small`         | Fewer than 2 columns, or no data rows                                |                     |

- **The version's `no_table_reason` holds one**: the first hit, in the order above
- With `multiple-sheets` or `encrypted` there is no single sheet to judge, so no other reason is counted
- **Every reason hit goes to `reading_proposal.reasons`** (§8.3). It counts which conditions drop the
  most and is where Step 2's proposal starts
- Rule IDs are attached in the display layer (ADR-057 Decision 5), not in judging

## 6. The intermediate CSV and `interpretCsv`

### 6.1 Writing it

The range of the reading instructions is written to an intermediate UTF-8 CSV (ADR-057 Decision 6).

- Line 1 is the column names: the header row's text for a plain table; from Step 2, the joined names
  or the ones a person changed
- From line 2, the first data row to the last row of the range. **No row inside the range is dropped**
- Raw values. Dates as ISO 8601. Formulas as their cached result
- In the data only a merge's top-left cell holds the value (a plain table has no merges in range)
- Hidden rows and columns are written too
- The intermediate CSV is a working file and is not kept

### 6.2 The option added to `interpretCsv` (PR 1-c)

```ts
type CsvStructure =
  | { inferred: { skipRows: number } }
  /** Where the table is was decided before the CSV was written: read it as written. */
  | { given: { textColumns: readonly string[] } } // §6.3
```

With `given`:

- No title-row scan (no rows skipped)
- Line 1 is declared the header (`header = true`)
- The delimiter, quote and escape are pinned to `,`, `"` and `"`: this process wrote the file, so it is
  not left to the sniffer, which takes `'` for the quote when every value is in `'`, and `;` for the
  delimiter when a line has more of them than `,`
- **No inference of trailing notes (`settleSignOffs` and dropping trailing rows).** That inference
  takes a sparse trailing row for a note and can drop a row holding only "Total" and an amount at the
  end of a wide table

Type inference, settled types, no-value marks, numbers written as text and the table profile go on
as before. CSV behaviour is unchanged (only the Excel route passes `given`).

### 6.3 Columns of text cells only

In Excel, codes like `00123` are often entered as text cells. Writing them to CSV loses that, and the
sniffer infers a number and drops the leading zeros.

**A column whose data cells with values are all text cells gets text (VARCHAR) as its initial
`types` entry.** A settled type a person set wins. Numbers written as text (ii-c) are judged on text
columns, so values like `1,234` are still counted as before.

## 7. Into the pipeline (Step 1)

### 7.1 The Interpret step

Today XLSX and XLS go down the `isDocumentFormat` branch, their text is extracted and that is all.
It becomes:

1. Document text extraction as today (the full-text index does not change, ADR-057 Decision 8)
2. Then the grid is read in the heavy child and judged by §5
3. A plain table: the intermediate CSV is written and `interpretCsv` (`given`) makes the Parquet and
   schema
4. Otherwise: `NO_TABLE`, the reason and `reading_proposal` are written to the version

The workbook is downloaded once, and both the table and the text read that copy. A failure while
reading the table does not fail the step: a warning is logged and text extraction goes on (the
workbook stays a document, as before tables were read).

A resource with settled reading instructions (from Step 2) is read in §3.3's order: with the settled
instructions if the settled header is found, otherwise back to plain-table judging.

### 7.2 Re-interpreting existing versions (PR 1-e)

Two routes are needed. The layer-2 sweep alone does not change the public preview.

| Route                              | What changes                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The layer-2 sweep (`lakeLoadable`) | With `xlsx` and `xls` in `TABLE_SOURCE_FORMATS`, it picks up every existing Excel version without a schema, writes the version's `schema` and loads layer 2. **It does not keep the temporary Parquet for the public, and does not update `resource_pipeline`'s `previewKey` or schema** |
| Reprocessing the resource          | Interpret runs again on the newest version, keeps the public Parquet and updates `resource_pipeline`. The preview, OData and MCP read this                                                                                                                                               |

- **PR 1-e queues a reprocess of the Excel resources once.** The existing bulk reprocess (the bulk
  enqueue in `PipelineService`) gets an option to narrow by format. No version is added (neither the
  bytes nor the settled instructions change, ADR-046)
- Older versions' schemas and layer 2 are left to the sweep
- **Count before release.** For each demo site, the number of Excel resources and of `active` versions
  and their total size; estimate how many hours the reprocess and the sweep take
- On a site with many, between shipping 1-d and 1-e, reprocess a few by hand and look at the result

### 7.3 Places that branch on format

As ADR-057 Decision 9 says, for Excel the branch is on whether the version has a schema.

| Place                                                                                           | Today                                         | Change                                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web/.../preview/resource-preview.tsx`                                                     | Table by `isCsvFormat`                        | Excel with a schema: table; without: the drawn original                                       |
| `packages/api/.../suggest/materials.ts`                                                         | Table by `isCsvFormat`                        | Same                                                                                          |
| `packages/api/.../ai/summary-estimate.ts`                                                       | Table by `isCsvFormat`                        | Same (whether the summary's material moves to the table is ADR-053's call)                    |
| `TABLE_SOURCE_FORMATS` in `packages/shared/src/formats.ts`                                      | CSV, TSV, JSON                                | `xlsx` and `xls` added                                                                        |
| `isTableSourceFormat` in the same file (decides CSV and JSON one by one, not from the constant) | CSV, TSV, JSON                                | Decided from the constant, Excel included                                                     |
| `apps/web/.../dataset/resource-info.tsx` (fetching the schema)                                  | `isTableSourceFormat`                         | Fetched for Excel too; without a schema, as today                                             |
| `apps/web/.../resource/resource-pipeline-preview.tsx` (column list)                             | `isTableSourceFormat`                         | For Excel, the column list only when there is a schema                                        |
| `apps/web/.../[resourceId]/resource-editor.tsx` ("Table settings" tab)                          | `isTableSourceFormat`                         | **For Excel, the tab is shown even without a table** (it is where Step 2 settles the reading) |
| `apps/worker/.../steps/interpret.ts`                                                            | Table interpretation by `isTableSourceFormat` | Excel does table interpretation inside the document branch (§7.1), before this check          |

Whether an Excel that became a table can switch to the drawn original is ADR-057 open issue 4. At
first the table preview keeps a "view the original" switch (today's preview is not lost).

## 8. The rules' proposal (Step 2)

### 8.1 Making it

For a sheet that misses the plain-table conditions, the rules make a proposal of reading
instructions. The cues are in ADR-057 Decision 4's order (sequence of row types, Excel's settings,
the shape of merges in the header band, words for totals, notes and units). The spike's rules
(`rules.py` in the evaluation set) are ported to TypeScript.

A proposal on which the sequence of row types and another cue agree is shown as "likely".

The port copied the spike's use of the cues as it was, which differs from Decision 4's wording in two
points. The spike's use is taken as correct (the measured figures come from it; 2026-11-23).

- **Excel tables (ListObject) are not a cue.** The grid reader does not read them. The sample had
  only 3, and one sheet depended on it
- **The autofilter joins the vote on the first data row.** Like frozen panes, print titles and the
  merge band, two or more pointing at the same row win over the sequence of row types. It is not used
  for the left and right edges

The ported rules matched 88 of the 111 hand-checked answers (the spike 89; the one difference used an
Excel table as a cue). 45 proposals were "likely", 40 of them right.

### 8.2 Joining column names (decided 2026-11-23)

A multi-row header becomes one name per column.

- Parent and child are joined from the top. **The separator is `_`** (as for nested JSON column
  names, ADR-063 Decision 10)
- A merged cell's value is given to every column in its range
- **A part equal to the one above is not repeated.** A vertical merge, or the same text written below,
  becomes one part (not "区分_区分")
- Empty parts are skipped. **A column with no part at all is named by its letter (`A`, `B`, …)** (a
  row-label column under an empty top-left header cell, for example): independent of language, and a
  person can change it
- A joined name that repeats gets `_2`, `_3` from the second on

Besides `_`, a space, `／` and `・` were candidates. `_` works as is in SQL and OData column names and
matches JSON tables, so it is `_` for now.

### 8.3 Shapes one rectangle cannot express

Tables whose header or notes appear again inside the range, tables folded sideways, and multi-column
layouts cannot be read correctly with any range and number of header rows (ADR-057 Context 7).

- Rules cannot tell these from named tables stacked or side by side (where reading the first table is
  right): in both, the header appears again outside the range (§5.5). Of the 17 sheets where the
  header repeated, on 11 the rules' first-table proposal equalled the person's answer
- **So the first table's proposal is given, noted "the header repeats; this proposal reads the first
  table only; a folded or multi-column table cannot be made a table"** (decided 2026-11-23). On the
  screen with borders (§9), a person judges the shape
- The reason (`multiple-tables`) is recorded on the version
- A person may still choose a range and settle it (read the first table only, for example)
- No unfolding option and no option to stack blocks of the same shape. Decided after counting this
  reason

### 8.3.1 Recording the proposal

The worker writes `resource_version.reading_proposal` (jsonb).

```ts
interface ReadingProposal {
  /** The rules' proposal, absent when the shape cannot be expressed (§8.3). */
  rules?: TableReading & { likely: boolean }
  /** Every reason the sheet missed the plain-table conditions (§5.8). */
  reasons: NoTableReason[]
  /** AI's proposal (Step 3), with whether it agrees with the rules'. */
  ai?: TableReading & { kind: string; agrees: boolean }
}
```

When a person settles, whether the proposal and the settled value agree is recorded in the audit
log. The share of agreement is material for widening what is automatic (ADR-057 open issue 1).

### 8.4 The grid artifact

The settling screen draws cell values, merges and borders (§9). The worker makes this and puts it in
storage.

- **Made when the screen is opened.** Making it for every non-plain Excel version would spend storage
  on versions nobody opens. Opening the "Table settings" tab makes the API queue an `excel-grid` job,
  and the worker reads the grid from the version's bytes and writes it. Later opens use what is there
- Shape: per sheet, chunks of 500 rows as JSON compressed with zstd. The screen fetches chunks as it
  scrolls
- Content: each cell's display value (raw; dates as ISO), merges, borders (line style), hidden rows
  and columns
- The version's bytes never change, so it is never remade. It goes when the version is purged

## 9. The settling screen (Step 2)

A "Reading" section is added to the "Table settings" tab (ADR-072). As ADR-057 Decision 10 says, the
review page built in the spike becomes the product as it is.

- Borders drawn by line style (thin, medium, thick, double, hair, dotted, dashed), merged cells shown
  merged
- Selecting a cell shows its address and the extent of its merge. Shift selects a range, and the
  selection can be taken as the range of the instructions
- A switch that outlines merged cells
- The rules' proposal (and AI's) shown as a frame and selectable. Without a proposal, the reason
- Header rows and column names (the joined names as the initial value, editable) are chosen
- Before settling, the range taken again on that version is shown (§3.3). If it differs from the
  selection, settling is not allowed
- The drawn original (ADR-065) is only shown alongside
- It goes into the same draft as the primary key and settled types; one apply makes one version

**Borders must be faithful to what Excel shows.** Drawing lines of different weight as the same line
makes the reader misread the divisions. Before the screen ships, a few sheets are compared side by
side with Excel. Lines around a merged cell follow Excel, which draws them with the format of the
merge's top-left cell.

## 10. Applying settled values (Step 2)

### 10.1 Applying

The same as applying settled types (ii-c §8.2).

- The API writes `column_settings.readings`. Version identity changes, so one version is added from
  the same bytes
- The new version is read with the settled instructions (§7.1); `reading.source` is `settled`
- A different reading gives different columns, so the primary key's or settled types' column names
  may be gone. The screen shows this before applying (as settled types' "settled column missing")

### 10.2 When the settled header is not found

In a later version the settled header band may not be found (§3.3).

| Case                                             | Handling                                                                                   | Reason             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------ |
| It reads as a plain table                        | Read by rules and made a table. Flagged for review: the settled instructions were not used |                    |
| The sheet is missing                             | No table. Flagged for review                                                               | `reading-no-sheet` |
| The header is not found, or found more than once | No table. Flagged for review                                                               | `reading-mismatch` |

- Reading with instructions that do not fit breaks the table itself: header rows in the data, shifted
  columns. Unlike settled types, making no table does less harm than carrying on
- Like type changes, review shows as the dot in the resource list and in the "Table settings" tab
  (ii-c §8.7)
- When a person fixes the instructions, one version is added and read again. Accepting "do not make
  this version a table" without fixing is also possible
- Added or removed columns are handled by §10.2.1

#### 10.2.1 When columns are added or removed

Added and removed columns are recorded as a schema diff since ii-a and are not a broken state. Looking
for the header band as a whole, one added column makes it unfindable. **Matching is done per column.**

- The header band at settling is held as the sequence of per-column names (the band joined from the
  top, §8.2)
- In a new version, for each candidate header band (from a top row, as many rows as the header has),
  the column names are joined, and the settled sequence is looked for **in order**. New columns may sit
  in between
- **Counted as found when** at least half of the settled columns appear in order, including the leftmost
  (the row-label column)
- The range's left edge is the leftmost column found. The right edge extends as far as header cells
  continue from the left on the header band (columns added on the right are included)
- If two or more places meet the condition, it is flagged for review as in §3.3
- Settled column names go to the columns matched to them. New columns get names joined from the header
- **Only added columns: the table is made with no review.** If a column was removed, the table is made
  and flagged for review (it may have carried the primary key or a settled type)

### 10.3 When a plain table stops being plain after an update

A resource with no settled instructions, made a table automatically by rules, may get a version that
misses the plain-table conditions (a two-cell note below the table, an empty header cell, and so on).

- **It is not read automatically regardless.** Loosening §5's conditions to read it would break the
  rule that a doubtful sheet is not automatic
- The version gets no table (`NO_TABLE` and the reason), and **that the last version was a table is
  flagged for review**, as the dot in the resource list and in the "Table settings" tab (ii-c §8.7)
- Left alone, the preview goes back to the drawn original, layer 2 stops receiving table versions and
  OData users stop getting updates. Happening silently, that is "an error that persists", so it is
  surfaced
- Recovery takes one settling. The settling screen's first proposal is the range found by looking for
  the reading the rules used on the last version (its header band's text and number of header rows) in
  the new version. If not found, the rules' proposal (§8.1). Once a person settles, later versions are
  read with the settled instructions (§3.3)

### 10.4 While under review, the last table keeps being served (decided 2026-11-23)

A resource fetched again from a URL is updated when nobody is watching. If a new version cannot be made
a table under §10.2 or §10.3 and the table stops, the preview goes back to the drawn original, OData and
MCP refuse with "no table", and BI tools fail to refresh. Everyone using it stops until a person fixes it.

**So while under review, the table of the last version that was a table keeps being served.**

- The new version enters layer 1 as usual (a version is added; the canonical object is the newest).
  The reason it could not be made a table and the review flag are recorded on it. It does not enter
  layer 2
- The preview, OData and MCP's `/query` serve the Parquet and schema of the last version that was a
  table
- **Serving an old table is not hidden.** The resource page says "the table is from version N; the
  newest version M could not be read as a table (reason)", shown so that it is plainly not the newest.
  API responses carry a flag saying it is not the newest (`stale: true`, with the table's version
  `tableVersion`, the newest version `latestVersion` and the reason `staleReason`), in the same place
  in the preview, the resource and MCP's `/query` responses. OData has little room for a notice in its
  responses, so it goes in the feed's description (an annotation in `$metadata`)
- Once a person fixes the instructions (or the sheet becomes plain again), the newest version is read
  and the table served is the newest again
- The last table is served **only when the last version was a table and the new one missed for a
  review reason.** A resource that was never a table, or a version that missed for reasons such as
  being too large, serves no table, as today

Today's readers require the table to describe the newest content (`describesLiveContent`: the
resource's hash matching the hash of what was interpreted). A state is added to that condition: "serving
the table of an earlier version, with the review flag". The interpretation's result (`resource_pipeline`'s
`previewKey` and schema) stays at the earlier version, with which version it is recorded. The same can
happen with CSV, but this phase is limited to Excel.

## 11. AI's proposal (Step 3)

As ADR-057 Decision 11 says.

- Input: the text form used in the spike (first 35 rows, last 10, sparse rows in between; first 14
  columns and last 2; cells per row; merges; Excel's settings; facts counted over the whole grid).
  **Borders are not given**
- Output: JSON with `kind`, `range`, `headerRows`, `columnNames`. `kind` gains shapes one rectangle
  cannot express (`repeat`, `fold`, `columns`). In the evaluation it found several tables the rules
  missed
- A proposal that fails the shape check or the check against the grid (rows or columns of the same
  shape continuing just outside the range) is discarded
- The model uses the same settings as ADR-040's suggestions (`AI_SUGGEST_MODEL` and so on). A small
  model is enough
- The call is made when the "Table settings" tab is opened, not when the version is created (the same
  job as §8.4), so no cost is spent on versions nobody opens
- Usage goes into the AI usage record

## 12. Evaluation

- The evaluation set (sample, answers, the spike's rules, scoring tools) stays outside the repository.
  The data is public, but raw data is not committed
- Once §5's rules are in TypeScript, they are run on every sheet of the sample (790 XLSX sheets, and
  the XLS) to give:
  - the number and share of sheets judged plain (in the spike, 25–33% of XLSX workbooks, 2% of XLS)
  - **a person looks at every sheet judged plain.** Zero errors are required. A single one adds its
    sign to the conditions that drop a sheet
  - a person looks at a few dozen sheets drawn from those dropped, to see the rules do not miss too
    many
- Unit tests use synthetic XLSX and XLS files for each §5 condition, both hit and missed
- Once Step 2's screen exists, a person checks the 58 answers still labelled by AI on it. The
  condition for widening what is automatic (ADR-057 open issue 1) waits for that

## 13. Impact and migration

- `reading`, `reading_proposal` and `settled_reading` are added to `resource_version` (Step 1 writes only
  `reading_proposal.reasons`; Step 2 the rest)
- `NoTableReason` gains §5.8's and §10.2's values. The dashboard's reason display gains wording
- `VersionIdentity` gains `settledReading` (Step 2)
- `xlsx` and `xls` are added to `TABLE_SOURCE_FORMATS`, and existing Excel versions are re-interpreted
  by the sweep (§7.2)
- Layer 2, OData and MCP look at the Parquet and schema, so no change is expected. PR 1-d checks with
  an integration test that an Excel that became a table enters layer 2 and is readable over OData
- An Excel row is added to `docs/pipeline.md` §10 (per-format processing)

## 14. Not done, or decided later

- Widening what is automatic (automatic when the rules' and AI's proposals agree, and so on): after
  the remaining answers are checked
- Several tables from one resource: a separate ADR
- Stacking sheets of the same shape, unfolding: after Step 2, once counted
- Using Excel tables (ListObject) as a cue: only 3 in the sample
- Showing bold, fills, column widths and line colour on the screen: once they turn out to be needed
- Having AI write the table itself: not done (ADR-057 Decision 11)
- **Telling editors about reviews**: today there is only the dashboard's dot, with no email or other
  notice. On a resource updated automatically from a URL, an old table could go on being served with
  nobody noticing. A shared issue with type-change reviews, handled separately
