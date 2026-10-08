> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/051-ichitaro-text-extraction.md`](../jp/051-ichitaro-text-extraction.md).

# ADR-051: Text Extraction for Ichitaro Documents (In-House Compound-File Parser, Ver.8 and Later Uncompressed Only)

## Status

**Accepted** — drafted 2026-09-11; revised to match the implementation and accepted 2026-10-08.

Extract the body text of Ichitaro documents (`.jtd` / `.jtt`) **into the same document text
artifact as other documents**. Extract it with a small compound-file (OLE2) parser in the
worker rather than an off-the-shelf library. Cover only the uncompressed formats of Ichitaro
Ver.8 and later; the compressed formats (`.jtdc` / `.jttc`) and everything before Ver.7 are
out of scope. The original is **drawn in the browser** by EZPZ File JTD, an open-source engine
that shows Ichitaro in the browser alone (WebAssembly, MIT); the extracted text's preview
appears as well, as it does for other documents.

> **Revised since the draft (2026-10-08).** After the draft, a document's text came to be
> extracted by Interpret into a located artifact (`text.ndjson.zst`) that Index, the text
> head, the extracted-text preview and the MCP section reader all read, and extracting
> the legacy Office formats produced an in-house compound-file reader. Accordingly:
>
> - Extraction sits in Interpret's document text extraction, not in place of officeparser in Index (decision 2)
> - npm `cfb` is not added; the compound-file reader shared with legacy Office is used (option B)
> - The text's extent comes from `TextV.01`'s length, and records are skipped by their length
>   (decision 3), following observations in OpenJTD's RFC 0003 made after the draft
> - Readings and template instructions go at the end of their line, not where they stand (decision 5)
> - No parse size cap of Ichitaro's own (decision 6)
> - The extracted-text preview is shown (decision 7; resolves open item 4)

> **Revised after acceptance (2026-10-08).** The original's display and the handling of sheets
> were added.
>
> - The text is read a sheet at a time, and a document of two or more sheets is a block a sheet
>   (decisions 2 and 3). As first accepted only the first sheet was read, and 7 of the 21 test
>   files lost the text of their later sheets
> - The original is drawn in the browser by EZPZ File JTD (decision 7, replacing the draft's "no
>   preview of the original"; resolves open item 4)

## Context

### Today

Ichitaro is still in active use across Japanese national and local government, and forms
and published documents are distributed as `.jtd`. KUKAN currently treats them like this:

- The `jtd` extension is absent from `FORMAT_MAP`. The format name falls back to
  uppercasing (`JTD`) and the MIME type becomes `application/octet-stream`
- The Index step's `getContentType` matches no predicate and returns `null`. Nothing is
  indexed; only the cleanup for a changed format runs
- Without a text-head artifact, the file is not material for AI metadata suggestions
  (ADR-040) either
- The preview says "not available"

Upload and download both work. The content is simply unreadable.

### The existing document path

PDF / DOCX / XLSX / PPTX / ODT / ODP / ODS / RTF carry `ContentType` `document`. The Index
step extracts text with officeparser, writes the first 64 KB to storage as a text-head
artifact, and splits the body into 500 KB chunks for the search engine. For a draft
dataset, search indexing is skipped and only the artifact is produced (ADR-039 / ADR-040
addendum).

officeparser **explicitly rejects** Ichitaro — it throws with a list of the formats it
supports — so adding the format alone does not put it on this path. The extraction
function has to branch.

### The format

A Ver.8-or-later `.jtd` is a compound file (OLE2 / CFB).

- The body lives in the `DocumentText` stream, which opens with the signature `SsmgV.01`
- Characters are UTF-16BE. A text run starts after control code `0x001F`; `0x001D` to
  `0x001E` delimits inline text (ruby base text, fill-in fields)
- The encoding is fixed by the format, so unlike CSV or TXT no detection is needed
- Newer versions split layout-frame text into `LayoutBoxText`. In a form authored with
  Ichitaro 2022, some headings existed only in that stream

Ver.7 and earlier (`.jbw`, `.jfw`, and friends) are not compound files at all: they begin
with `DOC\0` and hold plain Shift_JIS text. The compressed formats (`.jtdc` / `.jttc`)
nest a compound file compressed with LHA lh5 inside an outer compound file.

### No off-the-shelf extractor exists

| Option           | Status                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Apache Tika      | Ichitaro is absent from the supported-format list                                                                             |
| LibreOffice      | No import filter. The OpenOffice extension was last updated in 2009, is Windows-only, and no longer works                     |
| xdoc2txt         | Windows-only. Commercial use requires contacting the author                                                                   |
| OpenJTD (`rjtd`) | An Apache-2.0 Rust implementation. A reverse-engineering project started in June 2026; text extraction works, layout does not |

Nothing off the shelf runs on a Linux server. Every conversion route (Ichitaro itself, the
Ichitaro viewer, commercial PDF conversion APIs) assumes Windows plus an Ichitaro license.

### What was measured

Five `.jtd` files published by public bodies (four from the Ichitaro 2004 generation, one
from the Ichitaro 2022 generation) were run through a prototype built on npm `cfb`
(Apache-2.0, two dependencies, 370 KB unpacked) and through OpenJTD's `rjtd cat`. Character
bigram agreement after stripping whitespace:

| Sample            | Recall | Precision |
| ----------------- | -----: | --------: |
| 2004 generation 1 |  100 % |     100 % |
| 2004 generation 2 | 97.5 % |    99.7 % |
| 2004 generation 3 | 81.0 % |    97.0 % |
| 2004 generation 4 |  100 % |    99.8 % |
| 2022 generation   | 96.2 % |    79.2 % |

The recall gap comes from differing rules for selecting inline text. The lower precision on
the 2022 sample is the prototype also reading `LayoutBoxText`: that is extra content, not
loss. In-process extraction takes 0.4–0.8 ms for an 80–100 KB file, negligible against the
download and the index write.

Extraction picks up formatting data as text runs. OpenJTD carries the same proportion of
junk, so this is a limit of the "everything after `0x001F` is body" rule itself, not of one
implementation. Dropping any line whose non-whitespace characters fall below 50 % kana /
kanji / fullwidth / ASCII separated them cleanly:

| Sample            | Characters kept | Characters cut | Junk remaining |
| ----------------- | --------------: | -------------: | -------------: |
| 2004 generation 1 |             304 |              0 |              1 |
| 2004 generation 2 |             621 |             82 |              0 |
| 2004 generation 3 |             132 |              1 |              0 |
| 2004 generation 4 |             326 |             92 |              0 |
| 2022 generation   |             419 |             35 |              1 |

What got cut was binary lines repeating the same sequence; not one line of real content was
lost. Thresholds from 0.5 to 0.8 give identical results, because junk lines score near 0
and body lines near 1, leaving a wide gap between them.

## Options Considered

### A) Stay out of scope, register the extension only

Add `FORMAT_MAP` and MIME entries so the format displays as Ichitaro, and index nothing.
Nearly free, but documents distributed as Ichitaro stay invisible to full-text search. The
catalog keeps holding content nobody can find.

### B) Add an in-house compound-file parser (chosen)

Open the compound file and read `DocumentText` and `LayoutBoxText` in a worker function. The
draft planned to add npm `cfb`; extracting the legacy Office formats (XLS, DOC, PPT) produced
an in-house compound-file reader (`legacy/compound-file.ts`), which this shares, adding no
dependency. Format knowledge comes from OpenJTD's public specification notes; no independent
reverse engineering.

### C) Use OpenJTD via WASM or a sidecar

Extraction quality is equivalent — it is the baseline for the measurements above. But it
means carrying either a Rust 1.88+ build environment or a 3.7 MB WASM bundle, and making
the pipeline depend on a project at version 0.0.1. The extraction rules are a few dozen
lines; the dependency is not worth what it borrows. Referencing the public specification
notes borrows the finding without the coupling.

### D) Stand up a Windows conversion server and index the PDF

Run a separate Windows Server with Ichitaro and a commercial PDF conversion API, and have
the worker request conversions. This is the only route if visual fidelity is required, but
it brings Ichitaro and conversion-API licensing, adds Windows to a Linux-only deployment,
and the conversion API can only drive Ichitaro serially. For indexing alone the cost does
not balance.

## Decision

Take B, including the following.

### 1. Scope is Ver.8 and later, uncompressed only

Handle `.jtd` and `.jtt`. For `.jtdc` / `.jttc` and anything before Ver.7, **register the
extension and format name but do not extract**, because they are different formats: Node.js
has no LHA lh5 decompressor, and the pre-Ver.8 files are not compound files at all.
Registering now means at least showing "this is Ichitaro", and means adding extraction
later does not change the meaning of existing data.

### 2. Write the same document text artifact as other documents

Add `jtd` / `jtt` to `isDocumentFormat`. Interpret writes the document text artifact, and
Index (`ContentType` `document`), the text head (material for AI metadata suggestions and
summaries), draft handling, the extracted-text preview and the MCP section reader **all read it
unchanged**. No new `ContentType` — search has no reason to tell a PDF from Ichitaro.

Entering AI metadata suggestions automatically is **the intended effect**.

The artifact has neither pages nor headings. A document of one sheet is one block; one of
several is a block a sheet, numbered as a workbook's sheets are (`loc.sheet`). Sheets are not
named (`DocItemInfo`, which holds their names, is not yet decoded). What marks page breaks and
paragraph headings lives in other streams not yet decoded.

### 3. Read two streams: `DocumentText` and `LayoutBoxText`

`LayoutBoxText` is read because newer versions keep some form headings only there. Both are
concatenated into one text, `DocumentText` first.

Both streams are there **a sheet at a time**. The first sheet's are at the top of the file; each
later sheet's are in a storage of its own under `ObjectSheets/DocSheet/` (`DOCS_0001` and so on).
The sheets are taken first sheet first, then in the order of the storages' names — the order EZPZ
File JTD shows them in, so the original's preview and the extracted text number them alike.

The reading follows OpenJTD's RFC 0003:

- A stream opens with `SsmgV.01`; where it has a `TextV.01` block, the next 4 bytes (big-endian)
  give the text's length in UTF-16 units. **The text ends at that length**, and the style section
  after it is not read. An older version with no block is read whole by the rules below
- Text runs from a `0x001F` to the next control code; line breaks, CRs and tabs do not end it
- A record starting at `0x001C` gives its kind in its second unit and its length up to the
  `0x001F` it ends in in its third. **Records are skipped by their length** — their parameters
  hold printable values and `0x001D` too, so reading control codes one at a time mixes formatting
  into the text
- A non-inline record between runs of text is a table cell's end and becomes a tab; `0x000E`
  (a table row) and `0x000C` (a page break) become line breaks

### 4. Drop formatting data with a line-level plausibility filter

For each extracted line, **drop it if under 0.5 of its non-whitespace characters fall in the
ranges Japanese documents are written in**: ASCII; symbols (punctuation, arrows, circled
numbers, box drawing, shapes); CJK symbols, kana and kanji (with their extensions, past the BMP
too); full and half widths. Symbols were added to the draft's "kana, kanji, full-width, ASCII"
so lines of only circled numbers or rules are not dropped. Lines, not characters, for two
reasons:

- Dropping per character would also strip symbols and foreign words embedded in body text.
  Per line, a body line that really contains Greek letters survives while a binary-only line
  goes
- The middle dot (`・`) and the prolonged sound mark (`ー`) have Unicode Script Common, not
  Katakana. A Script-property test breaks body text. **Test by code-point range**

The 0.5 threshold sits mid-gap in the measurements; anything from 0.5 to 0.8 gives the same
result. Newer versions, read by their length-delimited blocks, carry almost no formatting under
decision 3; the filter mainly matters for older versions with no block.

### 5. Include inline text in the index, readings at the end of their line

An inline is a record of kind 1 holding characters between `0x001D` and `0x001E`. A fourth unit
of 0 is what is shown (a ruby's base, a form field's `○○○`); 1 is a reading or a template's
instruction. KUKAN **indexes both rather than discarding the latter**, but **puts the latter at
the end of its line, not where it stands**: there, `午后の授業` would become `午后ごごの授業` and
miss a phrase search. At the end of the line, a reading still finds the document.

### 6. No parse size cap of Ichitaro's own

Parsing a compound file loads the whole file. The draft planned a cap for Ichitaro alone, but
extraction runs in the heavy child process (ADR-059), and the fetch limit (100 MB) and the cap
on a document's total text (`DOCUMENT_TEXT_MAX_BYTES`, 256 MB) apply to every document. Ichitaro
forms are usually under 1 MB; a cap per format no longer earns its place.

### 7. The original is drawn in the browser by EZPZ File JTD; the extracted text's preview is shown too

The draft produced no preview of the original, as there was no way to reproduce its appearance.
OpenJTD's PDF output is blank (content streams contain only white rectangles) and its SVG output
is fixed-pitch text flow with no rules or frames. Given that Ichitaro files are mostly forms, a
preview without rules looks like a different document.

Since the draft, EZPZ File JTD (Rust compiled to WebAssembly, MIT, not affiliated with
JustSystems) has been published to draw Ichitaro in the browser alone. It draws ruled tables,
character sizes, ruby and paper sizes, and opened all 21 test files; it does not draw figures,
vertical writing, headers or footers. It is used for the "original" tab.

- **Loading**: only when the tab opens, the file's bytes are fetched from the preview endpoint
  (`/preview`, the PDF's route) and read by the WASM in the browser. The server converts nothing.
  The WASM runs in a Web Worker, so laying pages out does not hold up the page
- **When it does not end**: a request (opening, or laying out a sheet) that has not come back in 15
  seconds ends the worker and falls back to the guidance, as EZPZ has only just begun and inputs it
  cannot finish laying out may remain. The one known is avoided beforehand: where a file's margins
  do not fit its paper EZPZ falls back to its default margins, which on a small paper do not fit
  either; the line pitch goes negative and laying out never ends. A setup whose pitch would be under
  1pt is replaced by the default A4
- **Layout**: EZPZ's editor's layout engine sets each page on the grid of the document's style
  (paper, margins, characters × lines), and each page is painted on a canvas. The HTML export the
  upstream's simple viewer uses flows the text, so its line breaks and pages drift from the
  original's, and it is not used. The painting is ported from the editor
  (`ichitaro-paint.ts`, keeping its MIT notice)
- **Isolation**: what comes from the file is only coordinates and characters; nothing reaches the
  page as markup, so a crafted file cannot reach it
- **Sheets**: pages are laid out a sheet at a time; with two or more, a list of sheets inside the
  preview's frame switches between them. Their order and numbers match the extracted text's
  sheets (decision 3). Only the pages near the view are painted, and a canvas is emptied once
  it leaves (a document of many pages holds no pile of bitmaps)
- **Text cannot be selected**: being canvases, the pages do not take selection or find-in-page;
  the text is read under "extracted text"
- **When it cannot draw**: a compressed file, a broken one or an unsupported version falls back to
  the draft's guidance (download it and open it in Ichitaro or Ichitaro Viewer)
- **Distribution**: it is not on npm, so a wrapper crate (`apps/web/wasm/ezpzjtd-viewer/`) takes
  the upstream at a pinned commit and exports reading only. The editor is left out and the .wasm
  is about 320 KB. The build is committed under `apps/web/public/vendor/ezpzjtd/` and reaches the
  web image with `public/`; CI uses no Rust. Raising the version means running `build.sh`, which
  also regenerates the licence notices (LICENSE, NOTICE, THIRD_PARTY_NOTICES) and the commit taken
  (SOURCE)
- **Attribution**: "Powered by EZPZ File" at the preview's top right, and a note that figures,
  vertical writing, headers and footers are not shown. EZPZ's logos are not used (they are outside
  its licence)

The worry that the project has only just begun is held down by falling back to the guidance when
it cannot draw, and by taking a pinned version and comparing before raising it.

The extracted text is shown in the "extracted text" preview, as for other documents. The draft
left this as a separate decision (open item 4); with the document text artifact and its preview
now common to every document, there is no reason to leave Ichitaro out. That the text carries no
rules is true of every document's extracted text.

## Trade-offs

- **Depending on a format whose specification is not settled.** The basis is observation-led
  public specification notes, not a JustSystems document. An unseen version may break
  extraction, and it would show up as a quiet drop in character count. Tests can only guard
  regressions against fixed inputs
- **Table structure is lost.** Cells in a form become a flat sequence of strings with no row
  or column relationship. Enough for full-text search, not usable as a table
- **Junk is not eliminated entirely.** Even after the line filter, one or two stray symbols
  inside a real line survive. Harmless for search, but noise in AI-suggestion material
- **The original's display depends on an outside project.** EZPZ File JTD has only just begun,
  and a broken rendering makes KUKAN look broken. A pinned version does not change on its own,
  but taking its improvements means raising the version by hand, and the build is outside
  dependency audits (Dependabot and the like)
- **Compressed files remain unhandled.** `.jtdc` is a save format offered since Ichitaro 10
  and can appear in a distribution. Having put it out of scope, users need to see that
  compressed Ichitaro files are not indexed

## Impact (where it was implemented)

- `packages/shared/src/formats.ts`: `jtd` / `jtt` (and, out of scope, `jtdc` / `jttc`) in
  `FORMAT_MAP` and `MIME_MAP`. The MIME type is `application/x-js-taro` — not IANA-registered,
  but used by PRONOM and Apache convention. `jtd` / `jtt` in `isDocumentFormat`, the
  compound-file signature in `FORMAT_SIGNATURES`
- `apps/worker/src/pipeline/interpret/document/legacy/jtd.ts` (new): a pure function taking a
  Buffer and returning a string, touching neither storage nor the DB
- `apps/worker/src/pipeline/interpret/document/document-text.ts`: branch by format, routing
  Ichitaro to the function above
- `apps/worker/src/__tests__/`: extraction unit tests. **Inputs are built in the test** —
  compound files with the signature, length-delimited blocks, records, inlines and a style
  section pin the rules without committing third-party documents
- `packages/shared/src/__tests__/formats.test.ts`: the added predicates
- `CLAUDE.md`: a row in the pipeline per-format matrix
- `apps/worker/src/pipeline/interpret/document/legacy/compound-file.ts`: reads streams by path,
  into nested storages (the sheets after the first)
- `apps/web/src/components/ichitaro-preview.tsx` (new): the original's display and the list of
  sheets (decision 7)
- `apps/web/src/components/ichitaro-paint.ts` (new): the page painting ported from EZPZ File
  JTD's editor
- `apps/web/src/components/ichitaro-viewer.ts` and `ichitaro-viewer.worker.ts` (new): the Web Worker
  the WASM runs in, and the timeout on its requests
- `apps/web/wasm/ezpzjtd-viewer/` (new): the wrapper crate exporting EZPZ File JTD's reading only,
  and its build script; the build goes to `apps/web/public/vendor/ezpzjtd/`
- `packages/api/src/routes/resources.ts`: the preview endpoint serves an Ichitaro original too

Checked against real files (2026-10-08): text came out of all 21 forms published by Hokkaido,
Saitama and Tokushima (15 with length-delimited blocks, 6 without). The one piece of formatting
left was a check mark from a symbol font, stored as a character.

## Open Items

1. **Whether to add the compressed formats later.** Whether to implement lh5 decompression
   or stay out of scope depends on how often `.jtdc` actually arrives. The structure is in
   the public specification notes
2. **Whether to add pre-Ver.8 formats later.** The body is plain Shift_JIS so extraction is
   light, but Ver.8 shipped 29 years ago and no real files have been verified
3. **Pages and headings.** The artifact's only location is the sheet's number. Page breaks and
   paragraph formatting live in other streams (`DocumentTextPositionTables` among them); as
   their decoding progresses, pages and headings can be looked up as for a PDF
4. ~~**A way to draw the original in the browser.**~~ Resolved by decision 7 (EZPZ File JTD)
5. **How this surfaces to users.** Where and how to say that Ichitaro is an indexed format
   and that the compressed variants are not
6. **What extraction misses.** Against EZPZ File JTD's text output, this extraction reads far less
   of some documents, even of one sheet (a cover, contents and overview missing: 299 characters
   against 2,863 in one case). Decide whether to refine the in-house reading or to extract with
   EZPZ File JTD's engine as well (revisiting the judgement in option C)

## Related

- ADR-021 (resource content full-text search): where this ADR adds material
- ADR-039 (draft state) / ADR-040 (AI metadata suggestions): text-head artifact handling and
  suspending search indexing for drafts, both applying unchanged through the `document` path
- ADR-046 (Interpret stage): Ichitaro's text, like other documents', is extracted by
  Interpret from the version file into the artifact
- ADR-048 (single-surface table preview): the stance that appearance is built head-on per
  format, behind the draft's producing no preview of the original
- ADR-059 (heavy child process): where extraction runs, and one reason for no parse cap of
  Ichitaro's own
