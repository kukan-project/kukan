> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/051-ichitaro-text-extraction.md`](../jp/051-ichitaro-text-extraction.md).

# ADR-051: Text Extraction for Ichitaro Documents (In-House Compound-File Parser, Indexing Only)

## Status

**Proposed** — drafted 2026-09-11.

Put the body text of Ichitaro documents (`.jtd` / `.jtt`) **into the search index**.
Extract it with a small compound-file (OLE2) parser in the worker rather than an
off-the-shelf library. Cover only the uncompressed formats of Ichitaro Ver.8 and later;
the compressed formats (`.jtdc` / `.jttc`) and everything before Ver.7 are out of scope.
**No preview is produced** — this ADR buys the ability to find content, nothing about
reproducing its appearance.

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

Open the compound file with `cfb` and read `DocumentText` and `LayoutBoxText` in a worker
function. One new dependency, under 100 lines of code. Format knowledge comes from
OpenJTD's public specification notes; no independent reverse engineering.

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

### 2. `ContentType` is `document`; reuse the existing path

Add `jtd` / `jtt` to `isDocumentFormat`. That makes the Index step's branch, the text-head
artifact, the draft handling, and the AI-suggestion material check all work **unchanged**.
The predicate's doc comment, which says "formats officeparser can extract", no longer
matches reality and becomes "formats whose text can be extracted from a binary document".
No new `ContentType` is added: from the search side there is no reason to distinguish PDF
from Ichitaro.

Becoming eligible for AI metadata suggestions is an **intended** effect. The suggestion
side keys off the presence of the text-head artifact, so no extra branch is needed.

### 3. Read two streams: `DocumentText` and `LayoutBoxText`

`LayoutBoxText` is read because in newer forms some headings exist only there. OpenJTD does
not currently read this stream, so this is the one place the in-house parser is ahead. Join
both into a single text, `DocumentText` first.

### 4. Drop formatting data with a line-level plausibility filter

For each extracted line, **drop the line when the share of non-whitespace characters inside
the kana / kanji / fullwidth / ASCII ranges falls below 0.5**. Line level rather than
character level, for two reasons:

- Dropping per character also strips symbols and foreign words embedded in real text. At
  line level, a sentence that genuinely contains Greek survives and a purely binary line
  disappears
- The katakana middle dot (`・`) and the prolonged sound mark (`ー`) have Unicode Script
  `Common`, not `Katakana`. A Script-property test damages real text. **Test by code point
  range**

The 0.5 threshold takes the middle of the gap the measurements showed; anything from 0.5 to
0.8 behaves identically.

### 5. Include inline text in the index

OpenJTD splits the `0x001D`–`0x001E` region into visible text and ruby / template
instruction text and drops the latter. KUKAN **keeps both without selecting**. In the forms
measured, this region held form content such as "ア", "イ", and "印", a handful per file.
A few extra characters in the index do less harm than losing body text. In documents that
do use ruby, the readings also land in the index, which helps recall rather than hurting
it.

### 6. Cap the size that gets parsed

Parsing a compound file loads the whole file into memory. Ichitaro forms are normally under
1 MB, so **put a parse cap in the worker config**, separate from the fetch cap (100 MB),
and record rather than index anything above it. The existing document path has no such cap;
this format gets one first.

### 7. Produce no preview

Ichitaro previews stay "not available", because no means of reproducing the layout exists
today. OpenJTD's PDF export is blank (each page's content stream is only a white
rectangle), and its SVG export is a text flow at a fixed line pitch with no rules and no
frames. Given that Ichitaro files are mostly forms, a preview without rules reads as a
different document from the original. Emitting a text-only preview is an option, but it
sits outside this ADR and is decided separately.

## Trade-offs

- **Depending on a format whose specification is not settled.** The basis is observation-led
  public specification notes, not a JustSystems document. An unseen version may break
  extraction, and it would show up as a quiet drop in character count. Tests can only guard
  regressions against fixed inputs
- **Table structure is lost.** Cells in a form become a flat sequence of strings with no row
  or column relationship. Enough for full-text search, not usable as a table
- **Junk is not eliminated entirely.** Even after the line filter, one or two stray symbols
  inside a real line survive. Harmless for search, but noise in AI-suggestion material
- **Compressed files remain unhandled.** `.jtdc` is a save format offered since Ichitaro 10
  and can appear in a distribution. Having put it out of scope, users need to see that
  compressed Ichitaro files are not indexed

## Impact (what implementation touches)

- `packages/shared/src/formats.ts`: `jtd` / `jtt` (and, as out-of-scope entries, `jtdc` /
  `jttc`) in `FORMAT_MAP` and `MIME_MAP`. Use `application/x-js-taro` as the MIME type —
  unregistered with IANA, but the type PRONOM and Apache convention use. Add `jtd` / `jtt`
  to `isDocumentFormat` and correct its doc comment
- `apps/worker/src/pipeline/ichitaro.ts` (new): a pure function that takes a Buffer and
  returns the body text, touching neither storage nor the database
- `apps/worker/src/pipeline/steps/index-content.ts`: branch `extractDocumentText` on format
  and route Ichitaro to that function. Without the branch, officeparser always throws
- `apps/worker/package.json`: add `cfb`
- `apps/worker/src/config.ts`: the parse size cap
- `apps/worker/src/__tests__/`: unit tests for extraction, with inputs **synthesized using
  `cfb`** — building a compound file with the signature, text runs, an inline region, and a
  binary line inside the test pins the rules without putting third-party documents in the
  repository
- `packages/shared/src/__tests__/formats.test.ts`: the new predicate cases
- `CLAUDE.md`: a row in the per-format pipeline matrix

## Open Items

1. **Whether to add the compressed formats later.** Whether to implement lh5 decompression
   or stay out of scope depends on how often `.jtdc` actually arrives. The structure is in
   the public specification notes
2. **Whether to add pre-Ver.8 formats later.** The body is plain Shift_JIS so extraction is
   light, but Ver.8 shipped 29 years ago and no real files have been verified
3. **The value of the parse size cap.** A few MB suffices for real forms, but whether to
   align it with the existing document path is an implementation-time call
4. **A text preview.** Serving the extracted text as a preview artifact would put Ichitaro
   in the same shape as the ZIP manifest and make content readable. Treat it as a separate
   decision once indexing works
5. **How this surfaces to users.** Where and how to say that Ichitaro is an indexed format
   and that the compressed variants are not

## Related

- ADR-021 (resource content full-text search): where this ADR adds material
- ADR-039 (draft state) / ADR-040 (AI metadata suggestions): text-head artifact handling and
  suspending search indexing for drafts, both applying unchanged through the `document` path
- ADR-046 (Interpret stage): Ichitaro has no Interpret work. It produces neither a preview
  artifact nor a schema, so the stage passes it through
- ADR-048 (single-surface table preview): the stance behind producing no preview, that
  appearance is built head-on per format
