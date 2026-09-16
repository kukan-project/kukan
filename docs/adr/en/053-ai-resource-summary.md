> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/053-ai-resource-summary.md`](../jp/053-ai-resource-summary.md).

# ADR-053: AI-Generated Resource Abstracts — Inference Limited to Summary Prose

## Status

**Proposed** — spikes Phase A and Phase B have both been run (Appendix). What remains is the
before/after nDCG comparison (pass criterion 6), measured separately on local and on demo once
the abstracts are implemented.

Give each resource a short AI-generated **abstract** — in the bibliographic sense (JIS X 0813):
a short, accurate statement of a document's content, written so a reader can judge it without
opening the original, and serving as secondary material for retrieval. Those two purposes are
exactly this ADR's. **Display is the purpose; feeding the search embedding is a by-product.**
And **AI inference is limited to generating summary prose — it never produces a value a machine
trusts**: not column types, not primary keys, not the position of a header row.

Drawing that line makes the abstract an artifact that is reversible, degrades gracefully,
and that nothing else depends on. It leaves the pipeline's determinism (ADR-046) and the
foundation of row-level diffs (ADR-043) entirely undisturbed.

**This ADR defines an MVP.** Tables and text formats use material that already exists, PDFs,
Office formats and images are handed over whole (images scaled down where needed), and anything
over the cap is left out (decision 3). Generation runs as the pipeline's last step
(decision 4). Excerpting, conversion and routing are started only once the need is observed
("After the MVP").

## Context

### 1. Today the catalogue cannot see inside its own resources

The same gap shows up in two places.

**Display.** A PDF or Office resource page is effectively a download link. What the document
says is unknowable without opening it. Excel is the same: it never enters the CSV path, so it
has neither a preview nor a schema.

**Search.** The embedding material is assembled by `buildEmbeddingText`
(`apps/worker/src/embed/embed-package.ts`) from `title` + `notes` + `tags` plus each
resource's `name` / `description`. Municipal dataset titles are administrative
(`年齢別推計人口【年齢5歳階級別、年齢3区分別】`) and sit far from the everyday words people
search with. Tested against a public open-data catalogue, semantic search works where
keywords overlap and fails on paraphrases.

The two are one absence seen from two sides: **nothing anywhere puts the content into words.**
Measured, the embedding material averages **196 characters** (Appendix 3) — less a shortage
of vocabulary than **a shortage of material**.

### 2. Tables and documents are different problems

Tabular data already has structure. The column names and types Interpret settles
(`対象者数（人）`, `受診率（％）`) are themselves the words that describe the content, so
**adding column names to the embedding text buys the vocabulary outright**. No inference
needed.

Documents have no such structure, and the embedding is truncated at 8,000 characters
(`MAX_EMBED_TEXT_LENGTH`), so there is no way at all to fit a 200-page PDF. **For documents a
summary does its real job — compression, not paraphrase.** Here summarization is the only
route.

This ADR prices mainly the second case. The first (adding column, organization and category
names to the embedding text) costs no inference at all and can proceed independently.

### 3. Relationship to ADR-040

ADR-040's AI metadata suggestion is **proposal-shaped**: it generates when a person presses
a button, and a person approves before anything becomes metadata. The material assembly
(`ResourceMaterial` in `packages/api/src/services/suggest/prompt.ts`) and the per-format
handling live there already.

What is missing is **being automatic**. A abstract that only exists when someone presses a
button is not a abstract. And the moment it becomes automatic, three things the
proposal shape carried quietly disappear:

- **Consent** — pressing the button was itself consent to send content to an external AI
- **Approval** — prose reaches a public page without anyone checking it
- **Ownership** — text nobody maintains can sit in the catalogue indefinitely

This ADR answers all three explicitly (decisions 5, 7, 9).

### 4. What already exists

| Part               | Where it lives                                                 | Use here                              |
| ------------------ | -------------------------------------------------------------- | ------------------------------------- |
| Material assembly  | `ResourceMaterial` in `suggest/prompt.ts`                      | Material for tables, text and ZIP     |
| Encoding detection | `detectEncoding` / `bufferToUtf8` in `encoding-node.ts`        | Hand text formats over as UTF-8       |
| Skip-on-unchanged  | `embedding_hash` + per-package 60-second claim                 | The shape of regeneration control     |
| Capability query   | the precedent of `AIAdapter.getEmbeddingInfo()` returning null | Asking whether a document can be sent |
| Eval harnesses     | `pnpm eval:suggest` (ADR-040), `pnpm eval:search` (ADR-034)    | The spike's execution base            |

### 5. Measurement overturned the assumptions

Spikes Phase A and Phase B ran after the decisions were first drafted, and **eight assumptions
fell**. Every decision below is the post-measurement version. All evidence is in the Appendix.

| Assumed                                                       | Measured                                                                                              | Consequence                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Excel needs a structure-preserving conversion (a grid)        | median 19 KB, 98% under 4 MB; handing the original over lets the model read the layout itself         | No grid; hand the original over (App. 8, dec. 3.4)                                                                               |
| Excel is an order of magnitude cheaper than PDF               | same content: CSV 5,253 / XLSX 5,250 tokens. **One character ≈ one token in any format**              | "cheaper" was an artifact of comparing compressed bytes (App. 8)                                                                 |
| The embedding budget is tight                                 | average **196 chars**, none over 8,000                                                                | Add without dropping anything; the material is too thin (App. 3, dec. 8)                                                         |
| 20 resources need a dataset-level integration                 | the target catalogue holds up to **102 per package**; 28 of 294 (10%) exceed 8,000 characters         | Integration does not solve it either — concatenate for the MVP, then move to per-resource vectors (App. 15)                      |
| A byte cap is enough                                          | **2,500 tokens per page**, 100 pages is the API limit                                                 | Added a page cap (App. 2, dec. 3)                                                                                                |
| Everyday-word glosses are unnecessary (the embedding bridges) | glossed abstracts closer on **all eight queries**, +10 pt on everyday-word queries                    | Made the gloss the default (App. 6, dec. 3)                                                                                      |
| Documents are always best handed over whole                   | with a text layer, **extracted text is as good or better at 1.7–9.3× less**                           | Split the material on whether a text layer exists (App. 16, dec. 3.6)                                                            |
| "0 characters per page" means a scanned image                 | **the small model read a text-layer-free PDF accurately** (crisp type that merely refuses to extract) | **Failing to extract and being hard to read are separate axes**; where we cannot tell, err toward the model that reads (App. 16) |

## Decision (proposed)

### 1. The purpose is a abstract: display first, embedding as a by-product

"AI writes a description" hides three different products.

| Option               | What it is                        | Displayed | Cost of being wrong                    |
| -------------------- | --------------------------------- | --------- | -------------------------------------- |
| (a) Abstract         | What this file is                 | Yes       | Small (open the file and see)          |
| (b) Search backstage | Embedding material only           | No        | Invisible (nobody can catch an error)  |
| (c) Reading aid      | How to read it, caveats, insights | Yes       | Large (material cannot support claims) |

**Take (a).** Failure is cheapest, the benefit is most certain, and (b) comes free. (c)
demands a step change in quality while the material is a few KB of text and a few sample
rows — **a setup that asks the model to assert more than its material supports**.

(b) alone is rejected because **hidden AI text leaves nobody able to point at an error**.
Displayed text gets reported when wrong and an editor can fix it. A generated abstract did in
fact **point out a wrong resource name** (Appendix 6).

**Insights stay out of the embedding.** A sentence like "this shows an ageing population"
mixes in words that fit every dataset — it may raise recall while lowering precision. What
the model writes is **the contents, and everyday paraphrases** (decisions 3, 8).

### 2. AI inference is limited to generating summary prose

> **The only AI output a machine uses without human confirmation is the description and its
> embedding.**

This phrasing does not negate ADR-040's existing proposal flow (where a person approves).
What passes through approval continues as before; what does not is limited to prose.

**Column types, primary keys, header-row positions and sheet structure are not generated
here.** They belong to the spec's §14.1-4 (AI proposals for primary keys and types, an
ADR-040 extension) and need a different skeleton: propose → human confirms → persist as a
settled value.

The reason is determinism. The pipeline assumes the same input yields the same
interpretation (ADR-046). Put inference in the interpretation path and the same file can
produce a different schema on every run. **If a re-run shifts the header-row verdict by one
line, the row-level diff (ADR-043 layer 2) reports every row as changed.** Delegating values
means leaving a decision behind, not an inference.

**The cost is stated plainly: Excel does not become usable as data.** Without a structured
answer, XLSX gets no schema and no Parquet, and reaches neither the table preview, nor
`/query` (ADR-032), nor MCP. It becomes understandable, not touchable. Making it usable is
judged separately under §14.1-4.

### 3. Material — existing material for tables and text, the original for documents and images

The principle fits in one line.

> **Hand the original over only where nothing else gets at the content.** Documents with a
> text layer, like tables, are cheaper from material that already exists — and read at least as
> well. Where the content volume cannot be judged in advance, send it and let the error decide.

#### 3.1 Material per format

| Format                      | Material                                         | New code |
| --------------------------- | ------------------------------------------------ | -------- |
| CSV / TSV                   | Schema (names + types) + 5 sample rows           | none     |
| Text formats                | Head of the stored original                      | none     |
| ZIP                         | File listing                                     | none     |
| GeoJSON                     | Properties of the first few features + count     | small    |
| **PDF (text layer)**        | **Extracted text** (3.6)                         | small    |
| **PDF (thin text layer)**   | **The file itself** (3.6–3.8)                    | small    |
| **XLSX / XLS / DOC / DOCX** | **The file itself** (3.4)                        | small    |
| PPT / PPTX                  | **Extracted text** (no original can go, 3.4)     | small    |
| **Images**                  | **The file itself; scaled down over 5 MB** (3.4) | small    |
| Over the cap, size unknown  | **Not generated** (decision 5)                   | —        |

Tables and text formats reuse the existing material (ADR-040's `ResourceMaterial`) untouched.
**Tables are not handed over whole** — a Japanese CSV runs 700–860 tokens per KB, exceeds the
context window from 474 KB, and costs ten times the schema-plus-rows path (Appendix 7). The
column names and a few rows imply the rest.

PDFs split on whether the text layer is usable (3.6). **Where there is enough extracted text
it is the cheaper material — and reads at least as well**, by a measured factor of 1.7–9.3.
Only a thin layer gets the original, and then Bedrock's Converse and Anthropic's Messages API
both take the PDF as a document and rasterize the pages on their side. The only new plumbing is
the test and the handover, so **the MVP's implementation surface is small**.

#### 3.2 Metadata always goes with it — as context, not as material

A abstract cannot be written from the file alone. Dataset metadata is needed for
**grounding proper nouns** (a file that never names the municipality gives no ground for
writing it), **context** (which dataset this is one file of) and **avoiding duplication** (not
restating `notes`).

Yet what `buildResourceUserContent` (`suggest/prompt.ts`) passes to phase 1 today is only
`name` / `description` / `format` / `size` / `columns` / `sampleRows` / `textHead` / `files` —
**no dataset title, no organization, no tags**. ADR-040's `GROUNDING_RULES` allow proper nouns
grounded in the material **or the existing metadata**, but that metadata never arrives.

ADR-040 withholding it looks deliberate: shown the dataset title, **every resource becomes a
paraphrase of it**. Therefore:

- **Pass it as an explicit `datasetContext`**, never mixed into the resource's own material
- Carry the **title, organization, tags and the first few hundred characters of `notes`**
  (`notes` helps most and invites parroting most, so it is capped)
- State its role — **use it for context and for grounding proper nouns; do not settle for
  paraphrasing the metadata, and describe what this file contributes within the dataset**
  (touching on the subject itself is natural — decision 8)
- **Require technical and administrative terms to be glossed in everyday language.** An
  embedding shortens the distance between words but **does not invent them**; an everyday-word
  query never reaches a document whose text contains no everyday words. Glossed abstracts were
  closer on all eight queries, by around 10 points on everyday-word queries (Appendix 6)

It costs a few hundred tokens per resource — negligible.

**Metadata is context, not material.** A resource over the cap is not generated "because we
still have the metadata": paraphrasing what the page already displays has no value as an abstract, and writing without material is where hallucination lives.

#### 3.3 Caps are two-dimensional: bytes and pages

**Tokens follow page count.** Text PDFs and scans alike run 1,600–3,000 tokens per page, almost
regardless of how much text the page carries (Appendix 2). Bytes do not predict tokens — a
467-page PDF sat under 4 MB.

- **Bytes: 16 MB for PDF, 1 MB for Office** — the first gate, checkable from `resource.size`
  before downloading. **The original 4 MB was wrong** (note below)
- **PDF pages: 50.** The API's hard limit is **100 pages** (rejected with `A maximum of 100 PDF
pages`). 50 keeps 90% of PDFs; 100 would add four points of coverage for 1.2× the mean cost,
  and 30 would drop coverage to 70% (Appendix 2). **A file past it is not refused: its first
  50 pages are sent** (note below)

> **Note (revised during implementation, 2026-09-15) — the byte cap does not guard cost**
>
> The original 4 MB came from "87% of PDFs in another catalogue fit" — a **coverage** figure,
> which answers neither question the cap exists for.
>
> It was measured (Appendix 19). On Sonnet 4.6, with the page count pinned at two and the
> bytes padded by a stream no page draws, **3 MB and 22.6 MB both billed 3,158 input tokens**,
> and 22.9 MB was refused with `Input is too long for requested model.`
>
> **Bytes do not buy tokens. Pages do, and the page cap already bounds them.** What the byte
> cap actually guards is two things:
>
> 1. the API's own ceiling, measured at about 22.7 MB
> 2. the worker's memory — counting a PDF's pages means holding all of it
>
> So **PDF is 16 MB**: room inside the first for the rest of the request, comfortably inside
> the second.
>
> **What 4 MB was costing was the scans.** A 38-page, 6.9 MB survey report has a text layer of
> 37 characters, all newlines, so 3.6's "hand the original over when the layer is thin" is the
> only path it has — and the byte cap refused it on weight alone. At 16 MB it got an abstract.
>
> **Office stays at 1 MB.** Its rationale is different and still holds: an XLSX's bytes do
> translate into tokens, with 1.5 MB reaching 919k (Appendix 11), because it has no
> intermediate page representation the way a PDF does.

**The cap is set by cost, not by coverage.** Uncapped, the mean per resource rises to 23k
tokens; capped, it falls to 4k (Cost).

**No API parameter caps input tokens.** Converse's `inferenceConfig` carries only `maxTokens`
(an **output** cap), `temperature`, `topP` and `stopSequences`, and the Messages API's
`max_tokens` is likewise output-only. Only three levers reach the input side.

| Lever                  | How it binds                      | Precision                             |
| ---------------------- | --------------------------------- | ------------------------------------- |
| Model choice           | the context window is the ceiling | Hard, but tied to generation (dec. 6) |
| Byte cap               | decided before downloading        | Format-dependent (Appendix 8)         |
| Estimating client-side | measured before sending           | Measured per format (below)           |

| Format     | Estimate          | Measured             |
| ---------- | ----------------- | -------------------- |
| PDF        | **pages × 2,500** | 1,985–3,078 per page |
| CSV / text | characters × 1    | 0.99 per character   |
| XLSX       | characters × 1    | 1.08–1.22            |

**A PDF's pages can be read with pdf-lib in pure JS.** CSV and text are never handed over, so
they do not arise. **Only XLSX and DOC still need the file opened to estimate** — which 3.4
handles with errors instead.

#### 3.4 Office formats are handed over whole; oversize is caught by the error

**XLSX / XLS / DOC / DOCX are handed over like PDFs.** Measured, a 22 KB DOCX is 761 tokens, a
92 KB one 14,491, and a 46 KB DOC 682 (Appendix 11). Spreadsheets used as forms are no longer a
problem either: handing the original over lets the model see the layout, so **nothing has to
derive a schema** and nothing breaks when one cannot be derived.

**What remains is that token volume cannot be estimated in advance.** An XLSX is
ZIP-compressed XML and its size says nothing about its content (8 to 1,445 characters per KB, a
191-fold spread — Appendix 8). Estimating means opening the file, and the MVP does not pay
that.

**So send it and let the error decide.**

| Error                                               | Meaning              | Handling                               |
| --------------------------------------------------- | -------------------- | -------------------------------------- |
| `ValidationException` on `document.format`          | format not supported | **Permanent** (per format)             |
| `ValidationException` / `prompt is too long: N > M` | too large            | **Permanent** (per resource; record N) |
| `ThrottlingException` / 429 / 5xx                   | transient            | **Retry** (decision 4.2's backoff)     |

**The oversize error returns the actual token count**
(`prompt is too long: 919286 tokens > 200000 maximum`), so **a failed attempt is itself a
measurement**; recorded, it gates the next one. Rejections return in 2.9–4.2 seconds, and a
`ValidationException` is a pre-inference rejection.

**Not recording a transient failure as permanent** is the implementation's key point.

**PPT / PPTX are not taken by the API.** Bedrock Converse's `DocumentFormat`
(`models/enums.d.ts` in `@aws-sdk/client-bedrock-runtime`) is
`csv / doc / docx / html / md / pdf / txt / xls / xlsx` — nine formats, none of them PPT. That
is a capability, not a choice, and 3.5's capability query handles it.

**But being unable to send the original does not mean there is no material.** The Index step
extracts and stores text for every format `isDocumentFormat` covers, PPTX included; the PPTX in
the working catalogue already had 1,955 bytes of it. Once decision 3.6 established that extracted
text reads at least as well as a document sent whole, **the formats whose original cannot go are
precisely the ones whose extracted text should be looked at.**

> **Send the original where it can go, read the extracted text where it cannot, and call it out
> of scope only when there is neither.**

This narrows the original "PPT is out of scope". That reason — the API will not take it — was
only ever a fact about the original, and the extracted-text path was established afterwards.

**Office formats themselves still send the original** (§3.6). Whether to swap them for extracted
text is a question for the same comparison; what changes here is only "do nothing when the
original cannot go".

**Images are handed over too, but their cap is a different kind.** Converse takes
`gif / jpeg / png / webp`, and **an image's tokens follow its pixel count, not its file size** —
an 8,256 × 5,504 photo scaled to 1600px is 1,697 tokens, **cheaper than one PDF page** (2,500)
(Appendix 13).

The cap is the API's hard **5 MB per image** (`image exceeds 5 MB`, model-independent). **That
is not a cap for holding tokens down but a limit on what the API accepts**, unlike the byte caps
on PDFs and Office files. Exceeding it records a reason and generates nothing (decision 5).

**Images over 5 MB are scaled to 1600px on the long edge before sending.** The target
catalogue's 19 images run 7.1–9.7 MB and all exceed 5 MB (Appendix 9), so without scaling not
one image could be handled.

Scaling **does not expand the image in full**. JPEG shrink-on-load (libjpeg's DCT-domain
scaling) applies, taking peak RSS for an 8,256 × 5,504 photo from **365 MB to 105 MB**
(Appendix 13) because the full-size bitmap — 130 MB — is never materialized. In Node, `sharp`
(libvips) does the same, and libvips itself works in strips. **Every image in the target
catalogue is a JPEG**, so this applies to 100% of the real cases.

The cost is **one dependency, `sharp`** (prebuilt binaries are published, so build requirements
do not grow) and a few lines. The pipeline's concurrency is capped by `p-limit`, so only a few
scalings run at once. **Going through disk (`streamToTempFile`) waits until a large
PNG actually causes trouble** — PNG has no equivalent of shrink-on-load.

**The error path guarantees feasibility, not cost.** The ceiling is the model's context window
(decision 6), and the byte cap is the only gate that acts beforehand. **Office files are capped
at 1 MB, below the PDF cap** — a 1.5 MB XLSX measured 919,000 tokens, which a 1M-context model
would accept and bill at $2–$4.60 for a single file (Appendix 11, 12).

#### 3.5 Provider capability is asked of the adapter

Following the precedent of `getEmbeddingInfo()` returning null and the embed job skipping,
**the adapter is asked whether it can carry this format as a document**. No branch on provider
name reaches the application layer, so ADR-005's principle holds. The AIAdapter interface
currently carries only a prompt string, so it **gains the ability to carry documents**
(Consequences).

**Format coverage differs by provider.** Where documents cannot be handed over (Ollama, NoOp),
CSV and text formats still get abstracts and PDFs do not. That is **a difference in format
coverage, not in feature set**, and it is stated rather than hidden.

#### 3.6 PDFs split on whether the text layer is usable

**Where there are enough characters per page, pass the extracted text; hand the original over
only where the layer is thin.** The threshold is 100 characters per page — the same signal
decision 5 uses.

Phase B generated from both materials for nine PDFs and compared them (Appendix 16).

| Characters per page | Original input | Extracted-text input |   Ratio | Verdict                              |
| ------------------: | -------------: | -------------------: | ------: | ------------------------------------ |
|               **0** |          8,234 |                  359 |    22.9 | **Original only**                    |
| 344–2,074 (8 files) |  3,987–128,154 |         2,390–15,060 | 1.7–9.3 | **Extracted text as good or better** |

**Where a text layer exists, handing the original over buys nothing.** A 44-page statistical
report cost 128,154 tokens as an original against 13,723 as text, and **the text-based output
was the more specific of the two** — it named the per-police-station and per-municipality
breakdowns the original's did not. The same held for a table of contents: the text layer
carries the contents verbatim, while the original handover re-reads them from page images.

**Only an empty text layer reverses it.** There the text arm correctly reported that it could
not determine the contents and **did not fabricate**, while the original arm read the
population table accurately down to the household count.

The change lowers cost: the demo catalogue's PDFs drop from **1.63M to 0.53M tokens (-68%)**,
taking the whole catalogue from **$8.51 to $6.30** on the medium model (Appendix 16).

**Office formats keep the original handover.** The same comparison has not been run for them;
the extraction path (officeparser) already exists in the worker, so it is measured later.

> **Note (revised during implementation, 2026-09-15) — "characters per page" must not be
> divided by the read cap**
>
> The extracted text is read up to 16,384 bytes (`SUGGEST_TEXT_HEAD_BYTES`, borrowed from
> ADR-040). Divided by the document's **total** page count, that is about 5,400 Japanese
> characters over however many pages there are — so **every PDF past about 54 pages reads as
> thin**, whatever it holds. The ratio is measuring the cap, not the file.
>
> A 467-page sewerage yearbook hit this. Its text layer is **1,034 characters a page**, ten
> times the threshold, and it was read as 11 and sent as an original.
>
> **So the ratio only decides when the read came in under its cap**, which is when it is the
> whole of what was extracted. A read that filled its budget has demonstrated a dense layer by
> filling it.
>
> **And this misjudgement did not fall on the safe side.** The original comment said the error
> "falls toward sending the original — the path that can read anything", but that yearbook's
> original came back with the model reporting it could extract nothing (next note).
>
> **Open question: the 16 KB read cap itself.** It is ADR-040's number, chosen for suggestion,
> and the abstract borrows it. Reading 6,198 characters of a 575,761-character yearbook reaches
> partway through the contents page and the introduction: the abstract stands, but its view of
> the whole comes from a table of contents. The right value for an abstract deserves its own
> measurement.

#### 3.7 A PDF past the page cap is sent as its first 50 pages

The original decision was to refuse it. **That bought nothing.**

Tokens follow pages, so the 50-page cap **is** the ceiling on what one PDF can cost. Cutting a
document to 50 pages costs exactly what accepting a 50-page document costs. Refusing gained
nothing and lost the abstract on **the files it is worth most on** — a 467-page sewerage
yearbook and survey reports of 165 and 135 pages were all silent.

**What the reader is owed is the fact that only part was read.** Decision 7's notice already
has a place for it (`coverage`): an original sent whole carries none, an original sent in part
carries one.

The material digest carries the page cap too, so **raising the cap rewrites what was written
under the old one** while leaving whole originals where they are.

#### 3.8 An encrypted PDF will not give up its pages

`pdf-lib`'s `ignoreEncryption: true` parses a protected document's structure **without
decrypting it**. That is enough to count pages, but `copyPages` then carries still-encrypted
content streams into a document with no key, and **every page arrives blank**.

Fifty blank pages were sent from a 467-page yearbook holding 575,761 characters. The model
correctly reported it could extract nothing.

**Counting is safe; taking pages out is not.** `isEncrypted` refuses the cut.

Note that the Index step's `officeparser` **does** extract all 575,761 characters from the same
file: it handles empty-password encryption (permissions-only protection) properly, so the
extracted-text path works for these documents. With 3.6's test corrected, this yearbook now
takes that path.

### 4. Generation is the pipeline's last step

**In the MVP the abstract is generated as a pipeline step, after Fetch → Interpret → Index →
Lake.** It is not a separate job.

Three reasons.

- **The original is already in hand.** Fetch has just retrieved it; a separate job would
  **download it from storage again**
- **The regeneration trigger comes free.** An abstract is rebuilt when its material changes, which
  is **exactly when the pipeline runs**. A separate job would have to reproduce that condition
  with its own hash comparison
- **The backfill path already exists.** Queue messages carry `{ resourceId, rebuildOnly }`, and
  `rebuildOnly` reprocesses without re-fetching the external URL. The embedding rebuild already
  uses it, and **a full abstract run rides the same path**

And it **avoids adding an SQS queue per site** (which would touch both CDK and compose).

#### 4.1 Three conditions that make it work

1. **Best-effort.** An LLM failure records a reason and **never fails the step**, so no
   dependency on the AI's availability is created
2. **Last in the sequence.** Neither its latency nor its failures reach anything upstream
3. **Backfill rides the existing `rebuildOnly` path, run when things are quiet.** Thousands of
   resources occupy the pipeline for about an hour, but **the embedding rebuild already has the
   same character** and the same operational habit applies

#### 4.2 What still has to hold

- **Never hold a DB transaction across the LLM call.** Take the claim, commit, call the LLM,
  then write. The worker's pool is `WORKER_DB_POOL_MAX` = 3, so holding a connection for the
  wait stalls the whole worker
- **A visibility timeout longer than the worst-case LLM latency.** Measured calls run 3–11
  seconds (Appendix 14), but size it for the worst case including retries after throttling. Too
  short and the message is redelivered, **billing the same generation twice**. The version-keyed
  hash keeps the result idempotent, but the tokens are not refunded
- **Back off exponentially on 429.** A backfill will meet them

It does not intersect DuckLake's catalog-wide lock: abstract generation never touches the lake.

#### 4.3 Separating the execution budget is left to the follow-ups

**The price is holding the per-resource execution claim (ADR-044) 3–11 seconds longer, and
sharing one concurrency budget with upload processing.** The pipeline already holds that claim
for seconds to tens of seconds across fetch, interpret and lake, so the increase is 20–50%.

When that becomes a problem, split it onto a dedicated queue and poller ("After the MVP").
**The trigger is whether upload processing has visibly slowed**, decided on observation like
decision 5's on-screen reasons.

### 5. State explicitly when nothing is generated, and show the reason

| Condition                    | Test                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| Over the cap, size unknown   | `resource.size`. **Applies only to formats handed over as binaries**      |
| Formats outside the MVP      | PPT formats, formats the provider cannot take (decision 3)                |
| **Rejected on sending**      | **`ValidationException`; recorded as a permanent failure** (decision 3.4) |
| Empty material               | No schema extracted from a CSV, empty text                                |
| Drafts and private resources | Only resources belonging to `state = active` packages                     |

**The size cap applies only to formats handed over as binaries.** CSV uses its schema and
sample rows, so **it is generated regardless of file size** — the target catalogue holds ten CSVs over 4 MB
(the largest 78 MB) and the material is identical for all of them. Tabular formats are gated
on whether a schema exists.

**In every case, the reason is shown on screen.**

> No description was generated: this file exceeds the size cap.

A missing description reads very differently with a reason attached. And **this doubles as the
observation point for whether the over-cap work is needed at all** — many such notices are the
evidence that justifies the follow-up work.

**The content of a draft or private resource is never sent to an external AI without a human
action.** This matches the line embeddings already draw ("drafts are embedded at publish",
ADR-039). A description for a draft comes from ADR-040's manual suggestion, where pressing the
button is the consent.

**The model's own report is recorded too.** The output (forced JSON) carries one flag for
"could this be described from the material". It costs about 10 tokens. But **the flag cannot
catch fabrication** — given a scanned PDF, a small model confidently invented contents it could
not read and never said so (Appendix 5). In the MVP the flag routes nothing; it is recorded and
measured.

**"Cannot" and "will not" are distinct states.** Where the AI adapter is NoOp the feature does
not exist; where decision 10 has it disabled, it is deliberately unused. The wording differs on
screen, matching the vocabulary `suggest/availability.ts` already carries.

### 6. Generation is a single per-resource phase; the default is the larger model

One completion per resource produces a abstract (200–300 characters). **No dataset-level
integration is generated**; the embedding takes the package's abstracts **concatenated**
(decision 8).

ADR-040 runs two phases (per resource, then a dataset integration); this ADR uses only the
first. Concatenation **removes one LLM call per dataset** and **keeps the vocabulary specific
to each file** that integration (compression) would shave off — exactly what the everyday-words
problem needs. Each context stays within the cap, so a small local model in a closed network
can do it.

**It does not fit every package, though.** In the target catalogue one package holds as many as
**102 resources**, and concatenating 300-character abstracts puts **28 of 294 packages (10%) over
8,000 characters** (Appendix 15). The overflow is truncated from the tail per decision 8's
assembly order, so **those resources' abstracts never reach the package vector** (they still show
on their resource pages).

**The MVP accepts that truncation.** The embedding material averages 196 characters today, so
even a package whose tail is cut ends up **far thicker than it is now**. Nothing regresses.

**And integration would not solve it either.** The packages that overflow are not repetitions
of one thing: around a hundred tables, **every one on a different subject** (Appendix 15).
Integration is compression, so the vocabulary specific to each table is shaved off either way.
**Folding a hundred subjects into one vector is the problem itself** — a matter of granularity,
which only decision 8's per-resource vectors address. The MVP is followed directly by that.
Dataset-level integration is reconsidered **after** those land, if it is still needed.

**Model choice is a cost decision and a correctness gate at once.** The reason is not "because
it is a scan", though — it is that **we cannot tell in advance how legible the material is**.

In Phase B a **small model read a PDF with no text layer accurately** (Appendix 16). It differs
in kind from the document the same small model fabricated in Phase A (1934 vertical old-form
print): this one came from `Microsoft: Print To PDF` — **crisp modern type that merely refuses
to extract**.

> **"0 characters per page" does not mean "scanned image".** Failing to extract and being hard
> to read are separate axes.

Characters per page tells us only whether a text layer exists; it says **nothing about how
legible the pixels are**. So on the original-handover path, **where we cannot tell, we err
toward the model that can read**.

Whether a text-layer-free document can be read at all turned on **generation, not model size**
(Appendices 5 and 12). On text documents the newer generation is also more complete and precise
about units, and **glosses terms in everyday language unprompted** (Appendix 10).

- **The default is a model generation that can also read degraded material.** The cost gap is
  $12 at 2,600 resources and $115 at 25,000, and **a fabrication costs more** — a false
  description on a public page is as hard to catch as a degraded ranking
- **A small model is imprecise even where it reads correctly.** From the same document Phase B
  had it write that older people are **"the majority"** of victims, where the larger model wrote
  that the share **"varies greatly by category"** (Appendix 16). The statements conflict, and it
  is the former that goes beyond the material
- **A small model must never be pointed at scanned material.** Turning the cost dial must not
  be a way to manufacture fabrications
- Routing by whether a text layer exists stays a lever for when volume makes it matter ("After
  the MVP")

**Amazon's Nova models run the same way. The larger, older Nova Pro is worse than the smaller,
newer Nova 2.0 Lite** (Appendix 18). Nova Pro did not read even a clean scan: it wrote from the
dataset's metadata alone. It costs a ninth of Sonnet 4.6, and **neither model can be used**.

### 7. Display carries a notice, and editors can take control

Shown on the resource page. The notice states that AI generated it, **what it was generated
from, and the source version.**

> This description was generated by AI from the opening section and excerpts of 87 pages
> (version of 2026-09-12).

Naming the material tells a reader what to verify; naming the **source version** (ADR-043)
makes it visible when a resource has moved on and the abstract has not. An out-of-date description
marked only as "AI-generated" is the worst shape.

**A disclaimer is shown, and it is not what protects anyone.** Text on a public page reaches
its reader as the catalogue's own statement, so "accuracy is not guaranteed" is not treated as a
transfer of responsibility. The line that has to hold is not in the wording but in **what the
model is allowed to say** (the four rules below).

That said, a disclaimer does one job the notice does not: it says **the file is the record**. An
abstract is by definition a secondary source (JIS X 0813), not something to finish deciding on.
That is an explanation of what an abstract is, not an evasion.

> Accuracy and currency are not guaranteed. The file itself is the authoritative record.

**A deployment that needs its own wording replaces it through the brand override layer
(ADR-023).**

- **Forbid claims beyond the material.** Periods, record counts and extremes inferred from 5
  sample rows are nearly always wrong and read the most convincingly. Phase A produced a
  quantitative claim despite the prohibition ("18 major expenditure categories"), so the output
  format constrains it too (pass criterion 1)
- **Instruct length in sentences, not characters, and give the reason.** Phase B measured that
  a character-count instruction was exceeded by 5 of 6 outputs, while **a sentence count (3–4)
  was honoured by all 6**. Adding the purpose ("this goes into a search vector on a budget")
  shrank the average from 353 to 295 characters (Appendix 16). **Never truncate mechanically by
  character count** — all 18 measured outputs ended on a full stop, and text only breaks
  mid-sentence when we break it. Where the budget binds, **drop whole sentences on the embedding
  side** (decision 8)
- For documents, "limited to what was read" — a period stated in the text may be quoted
- Proper nouns only where grounded in the material or existing metadata (ADR-040's
  `GROUNDING_RULES`)

**Editors can override or hide.** Shown by default; an editor's override promotes it to a
human description. Where a human description already exists, the AI text does not take the
lead.

### 8. The embedding contribution is added by rearranging, not replacing

**Metadata is not replaced; the assembly is rearranged.** The concatenated abstracts join
`buildEmbeddingText` and nothing existing is dropped. **Truncation does not actually happen** —
the embedding text averages 196 characters and peaks at 1,254, with none over 8,000
(Appendix 3). The assembly order is settled only as a safety net for a dataset with an extreme
number of resources.

**Where the budget binds, drop whole sentences.** Cutting by character leaves a sentence
unfinished. Abstracts end on a full stop (Appendix 16), so dropping the trailing sentence whole
keeps the text readable as it shrinks. **Moving to per-resource vectors removes the constraint
entirely** — one vector, one abstract.

| Order | Content                                   | Note                                       |
| ----- | ----------------------------------------- | ------------------------------------------ |
| 1     | title / notes / tags                      | unchanged                                  |
| 2     | **Concatenated abstracts (200–300 each)** | new                                        |
| 3     | Resource names                            | official file names; short and distinctive |
| 4     | Resource descriptions                     | first to go if the limit is ever reached   |

**The abstracts become the vector's dominant component.** Concatenating 3.6 abstracts × 300
characters onto material that averages 196 makes the embedding text several times longer. The
expected effect is large (82–95% of a abstract's vocabulary is absent from the metadata —
Appendix 3), and **so is the risk**: an abstract that misses makes the vector miss, and unlike a
display error, a degraded ranking is hard to see. Decision 1's "failure is cheap" was about
display. Confirming that retrieval has not regressed is therefore mandatory (pass criterion 6).

**Repetition is not wasted, but it diminishes quickly.** An embedding is the mean of its token
embeddings, so the larger the share a term occupies, the further the vector is pulled its way
(weighting). Weighting a term already present diminishes quickly, and repeating what every
dataset shares — organization names, boilerplate — **aligns the vectors and costs
discriminability**. Paraphrase and description of contents add new directions and do not
diminish. A abstract's 200–300 characters go to **what the metadata does not say**: contents,
granularity, coverage, everyday paraphrases.

**The abstracts become an input to the embedding hash.** Embedding skips unchanged packages by
the SHA-256 of the assembled text (`embedding_hash`), so one dependency chain is added:

```
resource content changes → the abstract regenerates → the embedding text changes → re-embed
```

**Enabling the feature changes every package's embedding hash.** Enabling runs in two stages:
the abstract backfill, then the embedding backfill. The latter calls no LLM and is cheap. Sites
with the feature disabled see no change.

**Per-resource vectors come directly after the MVP.** This ADR does not settle the
implementation, but it settles the order: ship the MVP on a package vector of concatenated
abstracts, then **add per-resource vectors and A/B them against it**.

The reason is measured. The target catalogue holds datasets of around a hundred tables in one
package, and **every table is on a different subject** (Appendix 15). Averaging heterogeneous
resources into one vector produces **a centroid that resembles no subject**, and on 10% of
packages the tail is truncated as well (decision 6). **Neither concatenation nor integration
fixes that; only granularity does.**

**The abstracts already exist per resource in the MVP, so the A/B costs no generation.** They are
staged apart because **shipping the abstracts and changing the vector granularity together would
make a retrieval regression impossible to attribute** — not because the need is in doubt.

#### 8.1 The abstract goes into the keyword leg too (added during implementation, 2026-09-15)

It went only into the vector at first. **Measured, that was not enough.**

Decision 3.2 has the model gloss official and administrative terms with the everyday word in
parentheses. Those everyday words land **in the document text itself**, which is precisely what
a term-matching index can use — and a person's description rarely spells both, so this is
vocabulary that does not exist without the abstract.

Three conditions over the golden set (39 queries). **Embeddings on Titan v2**, the Bedrock
adapter's default.

| Condition                      | Keyword only |  Hybrid |
| ------------------------------ | -----------: | ------: |
| A. no abstracts                |          38% |     82% |
| B. abstract in the vector only |          38% |     83% |
| **C. vector + keyword index**  |      **44%** | **84%** |

**Matching the embedding model to production adds on top.** Same catalogue, same condition C,
re-measured on `cohere.embed-v4` — what the AWS side runs.

| Embedding under C | Keyword only |  Hybrid | synonym | natural |
| ----------------- | -----------: | ------: | ------: | ------: |
| Titan v2          |          44% |     84% |     81% |     71% |
| **Cohere v4**     |      **44%** | **87%** | **82%** | **79%** |

(synonym / natural are hybrid nDCG; `natural` recall@10 also goes 95% → **100%**)

**The keyword figure does not move.** Putting the abstract in a term index does not depend on
the embedding model, so the model difference lands only on the vector side. The two add; neither
substitutes for the other.

> **The development environment was measuring on the default.** The adapter defaults to Titan,
> production runs Cohere, and A / B / C were all Titan numbers — not noticed until it was
> pointed out. That is why `.env.example` now names the model: **an environment left on the
> default measures something production does not do.**
>
> **And the numbers above were held down by one test dataset.** A childcare-support registry
> (a 12 MB XLSX, 134 chunks of free text) had been registered twice, once under a wrong title,
> and its prose contains nearly every everyday word there is — so the content leg answered
> most queries with it. Making it private alone moved synonym nDCG 82% → **93%** and natural
> 79% → **90%**. **The hygiene of the evaluation catalogue moves the numbers as much as the
> model or the index does.**
>
> **Short everyday words got a type of their own.** A one-to-five-character query like
> 「お年寄り」is too short to clear the vector floor, reaches the index only through the
> abstract's gloss, and has incidental mentions crowd its top ten. Averaged into the
> phrase-form synonym queries at 100% recall, that signal vanished — which was the ceiling
> the set had been at all day. Twelve of them as `word` measure 100% recall and **67%** nDCG
> against 90%+ for the other types: the right answers are in the top ten and ranked badly,
> visible at last. Three rank **worse** under hybrid than under keyword alone (車椅子
> 100% → 73%) — a weakly-cleared vector pushing the right answer down through RRF. That is
> the next thing to improve.
>
> **A `word` figure is tied to one generation of the abstracts.** Reprocessing can regenerate
> them (a changed version identity moves the `original:` digest; a changed Interpret output shape
> moves the schema digest), and the everyday-word bridge goes with the wording. Do not compare
> figures across a regeneration (ADR-034, re-measured 2026-09-16).

By type (keyword only, Recall@10):

| Type    |    A |    C |
| ------- | ---: | ---: |
| synonym |   0% |   8% |
| natural |  15% |  27% |
| exact   | 100% | 100% |

**Hybrid moves only one point because recall is already at its ceiling there, not because the
change does nothing.** Synonym nDCG rises 77% → 81% — the ranking improves — and `exact` holds
at 100%, so the generated vocabulary does not crowd out a search by a resource's real name.

**The six points on the keyword leg are real.** On a deployment with no vector leg
(`SEARCH_TYPE=postgres`) that figure _is_ the search quality. Nor is the case hypothetical: an
SSO token expired mid-measurement and hybrid **silently degraded to keyword**. The search looks
successful; only the results are halved.

> **What was fooled was the instrument.** The failure itself is recorded — `hybrid-search.ts`
> logs a failed query embedding at `warn` and a failed vector search at `error`. And yet
> `pnpm eval:search` reported 38% → 38% **as a valid measurement**. Hybrid matching keyword on
> every query is _evidence_ of that, not proof. **The search now reports what it did** —
> `applied`, `off` or `degraded` — and the harness stops without printing a number when any
> query comes back degraded, on the same non-zero exit it already uses for an `exact` regression
> (ADR-034's shipping condition).
>
> Inference was not enough: two legs can agree on a query by agreeing, and a valid run would
> have been failed. **What has to be told apart is a leg that ran and cleared nothing from one
> that never ran** — both return an empty list. In a live catalogue "お年寄り" clears the
> similarity floor on exactly one package, which is the search working, not failing.
>
> The numbers are **withheld, not annotated**. Printed with a warning beside them, the numbers
> are what gets remembered.
>
> **Degrading is itself correct.** A search that answers with keyword results alone beats one
> that errors. What needs fixing is not the silence but the instrument that cannot hear it.

**Having nowhere to write it was the implementation's point.** Summarize runs **after** Index,
so the document Index wrote describes a resource with no abstract, and nothing comes back for
it. Three paths rewrite it — the pipeline step, the backfill walk, and an editor's own change.
The last matters most for hiding: the public projection takes a hidden abstract off the
document, and a document that keeps it is **text somebody took down still answering searches**.

**Boosted below name and description.** Generated sentences should not outrank what a person
wrote.

### 9. Regeneration is keyed to the version; Batch is not adopted

An abstract carries its own hash and regenerates **only when the material (resource content or
schema) changes** — editing a title does not trigger it. The hash includes the model and
prompt version (the shape `embedding_model` + `embedding_hash` already uses). A full run lives
in the dashboard, next to `/admin/reindex-embeddings`.

**The Batch API (50% off) is not adopted.** Incremental generation cannot use it (up to 24
hours of latency), and the backfill saving does not justify implementing and maintaining
Bedrock's batch inference path (S3 manifest in/out, a different API from the synchronous
call). If a 100,000-resource catalogue ever needs it, only the backfill path has to be added.

What actually constrains a backfill is not money but **rate limits, throughput and
resumability**. With a version-keyed hash, a run that dies resumes by skipping what is done.

### 10. Disabled by default; enabled through the site's environment variables

Automatic generation carries inference cost that accumulates in proportion to resource count.
It is therefore **disabled by default**, and enabled through the site's environment variables.
It does not live in the runtime settings (ADR-036): a site administrator can change those, but
**the cost of this feature is borne by whoever deploys and operates the site** — the party
that sets it and the party that pays are not the same. Environment variables are already
per-site under multi-site deployment (ADR-041's SiteStack), so they are a sufficient per-site
switch.

ADR-038 removed `REGISTRATION_ENABLED` in favour of the runtime side, but that was an
operational judgement carrying no cost. This ADR chooses an environment variable because
**the burden sits elsewhere**.

**And that environment variable is the name of the model itself; unset means off.** A boolean
beside a model setting invents an "enabled but no model chosen" state that something has to
reconcile. **Choosing a model is also not a free setting** — threefold between Sonnet 4.6 and
Haiku 4.5, ninefold against Nova (Appendix 18) — so the reason above, where the cost falls,
covers it unchanged: the two are one decision. **A model outside the allow-list is refused, not
replaced by a default**: the default is only whatever comes first in `AI_COMPLETION_MODELS`, and
what a model that cannot read produces there is not a worse abstract but an invented one
(Appendix 18). Only the generation language stays a runtime setting, and the asymmetry explains
itself — language is free, the model is money.

**Enabling starts incremental generation only.** A full run is an explicit dashboard operation
that states the resource count and estimated token count before it starts; the estimate
follows from format, size and page count (Cost).

**While disabled, nothing is written.** Once enabled, everything can be built by reprocessing,
so the disabled state costs nothing. **Switching back to disabled never deletes existing
descriptions.** It only stops generation; bulk removal is a separate dashboard operation.

## Cost

**For the target catalogue (2,608 resources) the figure is $9.66–$48.30, and about
$0.97 a month in steady state** (Appendix 15; Appendix 9 is an earlier pass over the same
catalogue, taken before the material rules were settled). 98% of it is CSV at a 6 KB median with no PDFs and
no spreadsheets, and because the material is that small, **output tokens are 40% of the bill** —
there, the abstract's length matters more to cost than any input cap.

The tables below are the general estimate for catalogues with a different mix. Assumptions:
CSV 45% / Excel 20% / PDF 25% / other 10%, decision 3's caps (4 MB / 50 pages), giving **4k
input / 0.3k output per resource** (system prompt included). Measured, a PDF costs 2,500
tokens per page and a table 1–2k (Appendix 2, 7).

| Resources | Small | Medium |  Large |
| --------- | ----: | -----: | -----: |
| 2,600     |   $12 |    $24 |    $59 |
| 25,000    |  $115 |   $230 |   $575 |
| 100,000   |  $460 |   $920 | $2,300 |

Uncapped, the same rows read $65 / $121 / $303 at 2,600, and $1,160 for the medium model at
25,000. **The cap is the only real dial on cost** (decision 3).

Steady state (changed resources only) runs 0.6–2.8 cents per resource. A 25,000-resource
catalogue updating 5% a month costs **$7–$35 a month**.

**Cost is not a design input.** Cheapest against dearest is $12 against $59 on a
2,600-resource backfill. Choose on quality — and per decision 6, default to the larger model.

Prompt caching does not help here. Only the system prompt (~700 tokens) is shared, and the
material differs per resource, so there is no prefix to reuse.

> Unit prices are Anthropic first-party API rates (as of 2026-06; input/output $/1M: small =
> 1/5, medium = 2/10, large = 5/25). **On Bedrock the rate follows the inference profile** —
> `global.*` (destinations: every commercial Region) matches first-party, while a geography-bound
> profile such as `jp.*` (destinations fixed to ap-northeast-1 / ap-northeast-3) costs **+10%**.
> Measured on the 2026-09-12 bill. KUKAN defaults to `jp.*`, so **the Bedrock figure is the table
> above × 1.1**. Consumption tax is added separately by the biller (per the deployment's tax
> regime). Vertex is unverified.

## Spike

Run against a public open-data catalogue's real data (298 datasets / 2,608 resources), in two
phases. **Scope is limited to resources belonging to `state = active` packages** (decision 5).

> **Every spike measurement ran with `thinking` off.** Every cost, latency and length figure in
> this ADR assumes that (Appendix 17).

### Phase A — measure with no inference (done)

Coverage, bytes against tokens, and the number of resources with empty material. **The results
are in the Appendix.** Part of it was measured on a different catalogue (604 resources), and
re-running on the target catalogue is still outstanding.

### Phase B — generate over a stratified sample (done)

Nine PDFs from the demo catalogue, stratified by characters per page (0–2,074), compared along
three axes. **The results are in Appendix 16.**

| Axis         | Comparison                                 | Result                                                                 |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| **Material** | Original handover vs extracted text        | **With a text layer, extracted text is as good or better** (3.6)       |
| Model        | Small / larger                             | **Generation decides it — and density cannot predict it** (decision 6) |
| Wording      | Natural prose vs explicit everyday glosses | **+5.5pt for the abstract, +1.7pt more for the glosses** (3.2)         |

**The material axis changed decision 3.** The demo catalogue's cost drops from $8.51 to $6.30
on the medium model.

### Phase C — whether a cheap model can do this (done)

Amazon Nova costs an order of magnitude less, so it was measured separately. **It cannot be
used.** Document blocks go through, but forced JSON breaks and scans are fabricated.
**The results are in Appendix 18.**

**What remains is the before/after nDCG comparison** (pass criterion 6). The embedding
similarities are confirmed; the `pnpm eval:search` comparison needs the abstracts themselves, so
it follows the implementation.

### Pass criteria

1. **Zero claims beyond the material** (periods, counts, proper nouns). Even one means
   decision 7's prohibitions are not working; the plain prompt in Phase A produced one
2. **Figure-driven PDFs are read correctly** — what text extraction misses is picked up by
   handing the original over
3. **Agreement between the self-report flag and human judgement** — where the model said it
   could describe the file, does a reader agree?
4. **No generation attempted** on resources over the cap or with empty material
5. **It holds up as an abstract.** No sentence is cut off (all 18 measured outputs ended on a
   full stop). The character count is a guideline, and **the constraint disappears once
   per-resource vectors land** (decision 8)
6. **Retrieval quality improves.** Compare nDCG on `pnpm eval:search`'s golden set (ADR-034)
   with and without the abstracts. Since the abstracts become the vector's dominant component
   (decision 8), **confirming it has not regressed is mandatory**. Compare natural description
   against explicit glosses in the same run to confirm Appendix 6's similarity gap. Whether a
   gloss appears depends on the model and the material (none appeared for the care-provider
   file), so **track whether everyday terms are present in the output** as its own measure

   **Local and demo are measured separately.** The question sets are per-environment (the
   relevant dataset names differ by environment, which is why ADR-034 keeps
   `golden-queries.yaml` out of the repository), and **so are the embedding models**.

   | Environment | Question set               | Scale               | Embedding            | How to read it                             |
   | ----------- | -------------------------- | ------------------- | -------------------- | ------------------------------------------ |
   | Local       | `golden-queries.yaml`      | 39 Q / 168 packages | Titan v2 (1024 dims) | **A regression check**                     |
   | demo        | `golden-queries.demo.yaml` | 39 Q / 184 packages | Cohere embed-v4      | **The production shape** (this one counts) |

   Both hold 13 each of exact / synonym / natural. **The models differ, so absolute values are
   never compared** — only each environment's own before/after gap.

   **The baseline before abstracts** (measured 2026-09-12; overall nDCG, keyword-only → hybrid.
   Per-type figures are in ADR-034's "Re-measured"):

   | Environment | Baseline      | exact                         |
   | ----------- | ------------- | ----------------------------- |
   | Local       | **38% → 82%** | 100% → 100% (no room to slip) |
   | demo        | **29% → 87%** | 88% → 98%                     |

   Every relevant dataset name still resolves in both environments (local 56/56, demo 41/41),
   so **the before/after comparison runs on the sets as they stand**.

### Handling of outputs

The numbers are recorded in this ADR (the record lives here). Generated outputs are not
committed. Whether the harness ships in the repository is judged separately;
`pnpm eval:suggest` (ADR-040) is the closest shape and its structure is reused.

## Consequences

- **adapters/ai**: the AIAdapter interface gains the ability to carry **documents** alongside
  the prompt string, plus a capability query for "can this format be carried as a document"
  (the same shape as `getEmbeddingInfo()`)
- **worker**: one abstract step is added to the pipeline (last, best-effort)
- **api**: routes to fetch, override and hide the abstract; material assembly shared with
  `suggest/`, though **`buildResourceUserContent` needs a variant** — the suggestion flow
  (ADR-040) withholds dataset context from phase 1 and the abstract requires it (decision 3)
- **web**: resource-page display and notice, the reason shown where nothing was generated,
  editor controls
- **web (dashboard)**: the full-run operation and its pre-run estimate
- **db**: columns for the text, its hash, the source version, the generation time and the
  self-report flag
- **shared**: the enable/disable environment variable, the cap constants
- **worker dependencies**: `sharp` (image scaling; prebuilt binaries)
- **ADR-040's existing proposal flow**: unchanged; it only shares material assembly
- **The pipeline**: one step is added at the end; the existing four are unchanged

Re-run behavior is unchanged from ADR-046: a abstract is built from a version (an immutable
canonical file), so the same input yields the same material.

## Not doing (outside the MVP)

- **Generating values** (settling types, primary keys, header rows, sheet structure) — the
  spec's §14.1-4
- **PPT formats** (decision 3.4 — the API will not take them)
- **Full OCR** — a separate ADR's scope
- **Generating insights** — the material does not support them
- **Adopting the Batch API** — the saving does not justify the implementation (decision 9)
- **Automatic generation for drafts and private resources** — use the manual suggestion
  (ADR-040)
- **Turning `thinking` on** — **writing an abstract is reading, not reasoning.** Measured, it
  doubles the billed output and did not improve quality (Appendix 17). And at `effort: low`
  **adaptive thinking switches itself off** — the default (no thinking) is the state the model
  picks for itself. `effort` is a dial on thinking depth, so with thinking unused it has nothing
  to act on. To tighten the length, instruct sentences and purpose in the prompt as decision 7
  does — twice the effect, at no extra cost

## After the MVP

Decided **on the evidence**, once the MVP is out. Each of these approaches the MVP itself in
implementation size, so none is started before the need is confirmed.

### Material paths

- **Extracted text for Office formats** — for PDFs the extracted text proved cheaper and as
  good or better (3.6), but the same comparison has not been run for Office. The extraction path
  (officeparser) already exists in the worker, so it is measured and then decided
- **Page excerpting for PDFs** — assemble a small PDF of the opening pages plus a few from the
  middle with pdf-lib. Pure JS; no rasterizer (pdfium / poppler / mupdf) enters the image. The
  way to rescue PDFs over the cap
- **Office formats (XLSX / DOC / PPT)** — which of the two blockers to solve: spreadsheets used
  as forms defeat schema derivation, and bytes cannot enforce a cap. Opening the file to cap on
  character count makes original handover work, and once it is open a schema is derivable too.
  Detecting the form-like case (share of merged cells, presence of formulas, sparsity) could
  itself become material
- **A grid for Excel** — every sheet name plus the first few sheets as TSV, with formatted
  values, forward-filled merged cells, the used range trimmed and hidden sheets skipped. Unlike
  handing the file over, **it puts the token count in our hands**. Raw values would hand over a
  date as the serial number `46000`, and a merged cell's blank reads as "an empty column", so
  those two corrections are mandatory if a grid is built at all
- **Very large PNGs** — JPEG keeps memory down through shrink-on-load, and PNG has no
  equivalent (decision 3.4). Switch to going through disk (`streamToTempFile`) if it ever
  causes trouble
- **Stratified sampling of extracted text** — one leading block drowns in the cover and table
  of contents of a long report; take head, middle and tail evenly

### Separating the execution budget

- **A dedicated queue and poller** — split abstract generation out of the pipeline (decision 4.3).
  An LLM call takes 3–11 seconds against sub-second fetches and interprets, so sharing one
  concurrency budget makes uploads wait, most visibly during a backfill. Queues are already
  per-site under multi-site deployment (ADR-041), so one more costs little. **The trigger is
  whether upload processing has visibly slowed**
- **A second ECS service** — once it needs to scale independently. The same image, with
  `desiredCount` 0 where the feature is disabled, costs nothing when unused
- **Lambda is not the primary path** — it breaks ADR-041's principle that the application layer
  is identical on and off AWS, gives one piece of logic two entry points, and forks concurrency,
  retry and DLQ behaviour by environment. The binding constraints are not compute but **the DB
  connection budget and the provider's rate limits**, neither of which Lambda solves

### Cost levers

- **Routing by model** — characters per page decides whether a text layer exists, sending
  text-driven files to a small model and scans to a large one. The saving is about $109 at
  25,000 resources ($121 routed against $230 all-large). A lever for when volume makes it
  matter — and even then, never in the direction of pointing a small model at a scan.
  **Nova was measured as the cheap end of such a routing and does not qualify: it went beyond
  the material even where no image was involved** (Appendix 18)
- **Inference profile (Bedrock)** — moving from `jp.*` to `global.*` takes 10% off. But the
  destinations widen to every commercial Region, and per AWS the prompts and results **may be
  stored in Regions the account never opted into**, for abuse detection; the destination list
  also grows as AWS adds Regions (a geography-bound list never changes). **The 10% buys keeping
  the processing in-country** — not a choice to make on cost alone, and not available to a
  deployment that promises domestic processing

### Extending quality and reach

- **Per-resource vectors (directly after the MVP)** — the order is settled in decision 8.
  Averaging around a hundred heterogeneous tables into one vector produces **a centroid that
  resembles no subject**, and 10% of packages are truncated as well (Appendix 15). In
  implementation, ADR-034's vector search runs on PostgreSQL's pgvector over
  `package.embedding`; going per-resource multiplies the rows by about nine (ADR-034
  deliberately carries no index) and requires **aggregating dataset rank from resource
  scores**. ADR-025's parent-child lives on the keyword side (OpenSearch) and does not transfer
- **Dataset-level integration** (ADR-040's second phase) — reconsidered after per-resource
  vectors are in, if still needed (decision 6)
- **Other formats** — GeoPackage, FlatGeobuf and the like

### Operations and deployment

- **A two-layer switch** — the environment variable as a ceiling, with a valve in the runtime
  settings (ADR-036) that can only move it **downward**, letting a site choose a "no AI-written
  text" policy within what the operator permits. Nothing breaks as long as the upward direction
  stays with the environment variable
- **Converting Excel to PDF with headless LibreOffice** and merging it into the PDF path. It
  unifies the formats and preserves layout, but adds hundreds of MB to the image and seconds
  per conversion

### Independent of this ADR

- **The cheap improvement for tabular data** — adding column, organization and category names
  to `buildEmbeddingText`. It costs no inference and addresses the vocabulary problem for
  tables directly

## Open questions (to settle before the MVP ships)

1. The exact notice wording, and the generation language (both ja and en, or the default
   locale only — both doubles the cost)
2. Given the abstract lives in its own column rather than `notes`, whether it is exposed
   through the CKAN-compatible API
3. The concrete threshold for "empty material"
4. Which of the larger models to use (settled by Phase B)
5. The concrete assembly order for the embedding text (where decision 8's concatenation sits)
6. The shape of the AIAdapter interface extension — how documents are expressed and how the
   capability query answers, keeping ADR-005's "the application layer does not branch"
7. How to handle decision 6's truncation — the MVP accepts it, but the call is tied to when
   per-resource vectors (decision 8) land

## Appendix: Phase A measurements (2026-09-12)

Structure measured over a different catalogue (604 resources / 168 packages), with **token
counts taken from Bedrock by handing originals over** (Converse document blocks,
ap-northeast-1). Re-running on the target catalogue is still outstanding.

### 1. Size and structure

| Format |     Files | Distribution                                                                                   |
| ------ | --------: | ---------------------------------------------------------------------------------------------- |
| PDF    | 51 (≤4MB) | pages: median **2**, p90 45, max 467. Characters per page: median 1,071, minimum 486           |
| XLSX   |        60 | sheets: median 1, p90 3, max 13. Cells: median 800, p90 26,502, max 390,632. Six hidden sheets |

The eight PDFs over 4 MB (up to 52 MB) were checked separately; even a 2006 sewerage yearbook
of 498 pages carried a text layer at 1,014 characters per page. **All 60 PDFs in this
catalogue are text PDFs — not one scan.**

### 2. Tokens follow page count

| Kind                  | Pages |  Bytes | Text chars |       Tokens |  Per page |
| --------------------- | ----: | -----: | ---------: | -----------: | --------: |
| Text PDF              |     1 |  131KB |      1,559 |        3,078 |     3,078 |
| Text PDF              |     2 |  301KB |      1,665 |        5,012 |     2,506 |
| Text PDF              |    40 | 1.08MB |     42,858 |       95,891 |     2,397 |
| Text PDF              |    64 |  427KB |     28,802 |      127,041 |     1,985 |
| Text PDF              |    67 | 1.67MB |          — |      176,261 |     2,631 |
| **Image-only (scan)** |     5 | 1.67MB |      **0** |        8,019 | **1,604** |
| 135 / 165 / 467 pages |     — |      — |          — | **rejected** |         — |

**Whether a file carries 1,559 characters, 28,802 or none at all, its tokens follow its pages.**
The image component dominates, and a scan with no text layer is actually cheaper. Estimating
from extracted text understates by two to four times.

XLSX: 106 cells → 310 tokens, 3,136 → 8,365, 15,160 → 10,969. **An order of magnitude cheaper
than PDF.**

**100 pages is the API's hard limit** (`A maximum of 100 PDF pages`). 67 pages passed; 135, 165
and 467 were rejected — reached well inside 4 MB.

### 3. How much vocabulary an abstract adds

Character bigrams of each generated abstract compared against that resource's metadata (resource
name + dataset title + organization + tags).

| Sample                          |  Metadata | Abstract | Novel bigrams |   Novel |
| ------------------------------- | --------: | -------: | ------------: | ------: |
| Civic-group survey              | 101 chars |      265 |           165 | **82%** |
| Political organization register |  29 chars |      171 |           118 | **95%** |
| Expenditure settlement accounts |  54 chars |      226 |           171 | **95%** |
| Fiscal overview                 |  74 chars |      196 |           133 | **87%** |

**Eight to nine tenths of a abstract's vocabulary is absent from the metadata.** A resource named
"決算書　歳出" yields none of 議会費 / 福祉保健費 / 教育費 / 警察費 / 国民健康保険事業 /
都営住宅事業; the abstract yields all of them.

What it is strong at, though, is **technical vocabulary, not everyday words**. Even with a
system prompt demanding that technical terms be glossed in everyday language, the small model
produced no gloss in either of two runs. Models pull strongly toward **writing the words that
appear in the material** (decision 8, pass criterion 6).

### 4. Original handover versus extracted text (a figure-driven document)

A nine-page, chart-driven briefing at 308 characters per page, generated both ways from the
same file.

|                         | Input tokens | What the output carried                                                           |
| ----------------------- | -----------: | --------------------------------------------------------------------------------- |
| A. Original handed over |   **16,811** | One chart-derived figure ("56.7% of the national population by 2050")             |
| B. Extracted text only  |    **2,700** | "the share living in cities of 200,000+ rose from 15.3% in 1947 to 53.1% in 2015" |

**B was the more specific of the two, at a sixth of the cost.** Both carried the main points
(the three metropolitan areas, concentration in Tokyo, a fifth of inhabited land emptying by
2050, Sapporo/Sendai/Hiroshima/Fukuoka). **On this one file, handing the original over bought
very little for 6.2× the tokens.**

Even at the median (a 2-page PDF) it is 5,000 against 2,100 — 2.4× — and 2.2× at 40 pages.
**Against documents with a usable text layer, handing the original over costs two to six times
more.**

This unsettles decision 3. It is one sample, and the document was a slide deck whose key
figures sat in text boxes (that is, in the text layer). **Phase B tests it as its first axis.**

### 5. Scans are readable — but only by a capable model

Five scanned pages from NDL Digital Collections pid 1445565 (**"大審院判決全集 第1輯",
1934, 法律新報社**) were assembled into a PDF with no text layer at all.

**The larger model (Sonnet-class) read it correctly**

> A volume of civil and commercial case reports from the Great Court of Cassation … printed in
> vertical old-form characters with katakana … the validity of a minor's real-estate
> transaction without the family council's consent, rescission of an assignment of claims,
> choice of maintenance method under Article 961 of the Civil Code, application of Article 2 of
> the Commercial Code Enforcement Act …

**The small model (Haiku-class) fabricated entirely**

> This document collects academic papers and articles on the history and society of early Shōwa
> Japan … covering politics, economics and culture … It shows age-related deterioration, but
> the content remains fairly legible.

The small model **described the appearance rather than the content and filled the rest with
generalities**, and **never said it could not read it**. It is the concrete instance of the
worry recorded in decision 5 — that models are poor at saying "not enough" — and it shows the
self-report flag cannot catch this shape of failure.

### 6. Explicit everyday paraphrases do measurably help

The reasoning that "the embedding bridges the paraphrase, so the prompt need not demand it"
was tested directly against embedding similarity. Three texts were built for the same resource
and embedded with Cohere embed-v4 (the demo's configuration).

- **a**: metadata only (what `buildEmbeddingText` produces today)
- **b**: a + a naturally written abstract
- **c**: a + an abstract instructed to gloss terms in everyday language

**Childcare facilities list** (its resource name wrongly reads "観光施設一覧")

| Query                      |     a |     b |         c |    b−a |         c−b |
| -------------------------- | ----: | ----: | --------: | -----: | ----------: |
| 小さい子を預けるところ     | 0.253 | 0.278 | **0.390** | +2.5pt | **+11.3pt** |
| 子どもの預け先             | 0.281 | 0.331 | **0.429** | +5.0pt |  **+9.8pt** |
| 赤ちゃんを見てもらえる場所 | 0.283 | 0.271 |     0.305 | −1.2pt |      +3.5pt |
| 保育                       | 0.285 | 0.370 | **0.424** | +8.6pt |      +5.3pt |

**Long-term care providers list** (same wrong resource name)

| Query                      |     a |     b |     c |    b−a |    c−b |
| -------------------------- | ----: | ----: | ----: | -----: | -----: |
| お年寄りの介護サービス     | 0.362 | 0.374 | 0.383 | +1.2pt | +1.0pt |
| 高齢者向けの施設を探したい | 0.345 | 0.344 | 0.363 | −0.0pt | +1.9pt |
| 年寄りを預けられるところ   | 0.222 | 0.233 | 0.245 | +1.1pt | +1.1pt |
| 介護                       | 0.338 | 0.371 | 0.383 | +3.3pt | +1.3pt |

**c beats b on all eight queries**, and by around 10 points on exactly the kind of query this
ADR exists for.

The outputs explain why. b writes 保育施設 / 認定公立保育所 / 受入年齢 and **contains neither
小さい子 nor 預ける**; c writes 保育所（**子どもを預かる施設**）and 一時預かり（**短期間だけ
子どもを預けるサービス**）. **An embedding shortens the distance between words; it does not
invent them.** Without 預かる on the document side, 預けるところ never closes the gap.

**It is conditional, though.** The care-provider side gains only 1–2 points, because even c
produced no 高齢者（お年寄り）gloss — the CSV never says 高齢者, and the model wrote
"facilities and operators providing care and daily-living support" instead. **The instruction
helps only when the model actually emits a fitting everyday term**; instructing it does not
guarantee one.

Incidentally, b **pointed out that the resource name was wrong** ("the actual content is
long-term care provider information"). Abstracts also surface metadata errors.

### 7. For tables, schema plus sample rows is ten times cheaper than the original

CSVs from the target catalogue were handed to Converse whole.

|    Size |   Rows |                            Tokens | tok/KB |
| ------: | -----: | --------------------------------: | -----: |
|     6KB |     39 |                             5,253 |    859 |
|   145KB |    902 |                            97,273 |    673 |
|   474KB |  2,180 | **rejected** (prompt is too long) |      — |
| 2,779KB | 28,352 |                      **rejected** |      — |

**A Japanese CSV runs 700-860 tokens per KB** — every number, delimiter and code value is a
token — and **474 KB already exceeds the context window**.

Across the catalogue's 2,542 CSVs:

|                       | Original handed over | Schema + 5 sample rows |
| --------------------- | -------------------: | ---------------------: |
| Files that fit        |                2,429 |              **2,542** |
| Exceeding the context |       **113 (4.4%)** |                  **0** |
| Input tokens          |                57.8M |              **5.59M** |
| Sonnet-class          |              $122.82 |             **$18.81** |

**Ten times the input, and 4.4% cannot be sent at all.** A table is mostly repeating values;
**the column names and a few rows imply the rest**. The original buys far less here than it
does for a document.

### 8. File size predicts cost for some formats and not others

Converting the same content from CSV to XLSX gave **5,253 tokens against 5,250** — near
identical. **In every format, one character of content is about one token** (measured
0.68-1.22). What differs is only whether bytes reveal how much content there is.

| Format   | Content per KB                       |     Measured tok/KB |
| -------- | ------------------------------------ | ------------------: |
| CSV      | 871 characters, steady               |                 859 |
| **XLSX** | **8-1,445 characters (191× spread)** | **130 / 401 / 976** |
| PDF      | driven by pages                      |            about 39 |

The XLSX range splits between formatting-heavy files (84KB holding 8,989 characters → 130
tok/KB) and data-heavy ones (67KB holding 96,478 → **976 tok/KB**). **A data-heavy XLSX exceeds
CSV's 859** — ZIP compression packs more content into each KB.

The same content that was 6KB as CSV became 11KB as XLSX: **for small files the ZIP overhead
(multiple XML parts, sharedStrings, styles) outweighs the compression.**

**A byte cap on XLSX is therefore meaningless.** A 4 MB XLSX is 50,000 tokens or 4,000,000
depending on density (decision 3).

### 9. The target catalogue's formats and cost (earlier pass)

> Taken before the material rules were settled. **Appendix 15** carries the settled figures
> (5.79M input, $9.66–$48.30).

| Format        | Files |       Median |
| ------------- | ----: | -----------: |
| CSV           | 2,553 |         6 KB |
| ZIP           |    19 |        39 KB |
| JPEG          |    19 |       8.2 MB |
| shapefile ZIP |    16 | size unknown |
| DOCX          |     1 |       325 KB |

**Not one PDF and not one XLSX.** 98% of all 2,608 resources are CSV, at a 6 KB median.

Generating everything in MVP scope (CSV + text + ZIP) comes to **5.6M input and 0.77M output
tokens**:

| Model  |      Total |
| ------ | ---------: |
| Small  |  **$9.50** |
| Medium | **$19.01** |
| Large  | **$47.52** |

Steady state at 5% monthly churn is **$0.95 a month** on the medium model. **Because the inputs
are small, output tokens are 40% of the bill** — in this catalogue the abstract's length matters
more to cost than any input cap.

The 19 JPEGs run 7.1–9.7 MB and **every one exceeds the API's 5 MB limit**. Scaled down before
sending (decision 3.4) they cost about 1,700 tokens each, so their contribution to the bill is
negligible.

### 10. The larger model is better on text documents too

Same files, both models.

|                                 | Small model                                                                         | Larger model                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Political organization register | "names, office addresses, representatives, accounting officers, registration dates" | "**35 organizations**", "… registration date and **relationship to a Diet member**"                                           |
| Expenditure settlement          | "議会費, 総務費, 福祉保健費 … 18 major expenditure categories"                      | "**by 款/項 category**", "amount spent (**money actually used**), unspent balance (**what was left over**)", "**to the yen**" |

Beyond better coverage of fields and units, it **glossed terms in everyday language without
being asked** — the very behaviour the small model would not produce even under explicit
instruction.

**The cost gap is small.** All-small is $12 at 2,600 resources and $115 at 25,000; all-large is
$24 and $230. **The difference is $12 to $115.**

### 11. Office formats are cheap handed over, and oversize comes back as an error

| File                       | Result                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| DOCX 22KB                  | ✅ **761 tokens**                                                          |
| DOCX 92KB                  | ✅ **14,491 tokens**                                                       |
| DOC 46KB (legacy binary)   | ✅ **682 tokens**                                                          |
| PPTX 77KB                  | ❌ **format not supported** (`document.format` ValidationException, 0.1 s) |
| XLSX 1,581KB (1.13M chars) | ❌ `prompt is too long: **919286 tokens** > 200000 maximum` (4.2 s)        |
| XLSX 1,854KB (209K chars)  | ❌ `prompt is too long: **278916 tokens** > 200000 maximum` (2.9 s)        |

**Word files are cheap.** And **the oversize error returns the actual token count**, so a
failed attempt is itself a measurement. Rejections come back in 2.9–4.2 seconds, and a
`ValidationException` is a pre-inference rejection.

**The accepted document formats are defined as an enum in the SDK.** Bedrock Converse's
`DocumentFormat` (`models/enums.d.ts` in `@aws-sdk/client-bedrock-runtime`) is
`csv / doc / docx / html / md / pdf / txt / xls / xlsx` — nine formats, **none of them PPT**.
`ImageFormat` is `gif / jpeg / png / webp`. **This is Bedrock Converse's definition; Anthropic's
Messages API takes only PDFs and text formats** — the difference decision 3.5's capability query
absorbs.

**No API parameter caps input tokens.** Converse's `inferenceConfig` carries only `maxTokens`
(output), `temperature`, `topP` and `stopSequences`.

### 12. The context ceiling is a property of the model

The file already known to be 919,000 tokens was sent to each model to find its ceiling.

| Model          | Result                           |
| -------------- | -------------------------------- |
| Haiku 4.5      | Rejected. `> **200000** maximum` |
| Sonnet 4.5     | Rejected (`Input is too long`)   |
| **Sonnet 4.6** | **Accepted** (919,270 tokens)    |
| **Opus 4.7**   | **Accepted** (919,306 tokens)    |

**This measurement was itself an instance of the risk under discussion** — one file, one call
each, **$8.09** across the two models (confirmed on the bill: Opus $5.06 + Sonnet $3.03). On a
1M-context model, **the byte cap is the only gate that acts beforehand**.

And **the generation that reads scans coincides with the 1M context**. Given the same scanned
PDF as Appendix 5, Sonnet 4.5 (200k, large-class) **invented an organization that does not
exist** ("鳥取県一十五郡三郡組研究会"; the document is 大審院判決全集). It hedges more than
Haiku did ("思われます", "可能性があります"), but the substance is wrong. **The axis is
generation, not size.**

### 13. An image's tokens follow its pixel count

Measured on an aerial photograph from the target catalogue (8,256 × 5,504, 8.6 MB).

| Input                     | Result                                                        |
| ------------------------- | ------------------------------------------------------------- |
| Original, 8.6 MB          | ❌ **`image exceeds 5 MB`** (a hard limit, model-independent) |
| Scaled to 1600px (640 KB) | ✅ **1,697 tokens**                                           |

**Tokens follow pixels, not file size.** 1,697 is about the cost of one CSV (1.5k) and
**cheaper than a single PDF page** (2,500).

**Scaling does not expand the image in full.** Peak RSS for scaling the same photo to 1600px:

| Method                                   |   Peak RSS |
| ---------------------------------------- | ---------: |
| Decode, then resize                      | **365 MB** |
| **Shrink-on-load** (libjpeg DCT scaling) | **105 MB** |

The RGB bitmap at 8,256 × 5,504 is 130 MB, which the first method holds in full; the second
**never materializes it**. Most of the 105 MB is the runtime's own overhead.

The abstract produced (larger model; the resource's only name was "11_〈district〉全景".
**Proper nouns are redacted here**):

> An image from an aerial photography dataset published by 〈the port authority〉, showing
> a waterfront district from directly above. A waterway runs from the centre to the top of the
> frame, with wharves and quays along the water's edge … a grid of housing and a park-like green
> space containing a circular structure on the right … several vessels on the sea to the left,
> and structures that appear to be cranes and cargo-handling equipment on the quay.

### 14. How long generation takes

All one call per resource, producing 200–300 characters.

|  Input tokens | Model | Output | Elapsed |
| ------------: | ----- | -----: | ------: |
| 1,697 (image) | small |    294 |   4.2 s |
| 1,698 (image) | large |    277 |   6.0 s |
|         3,511 | small |    281 |   3.8 s |
|         5,393 | small |    242 |   3.1 s |
|  8,019 (scan) | small |    204 |   4.3 s |
|  8,021 (scan) | large |    278 |   9.0 s |
|        11,373 | small |    266 |   3.4 s |
|        96,337 | small |    221 |   7.4 s |

**3–11 seconds, with a median around 5.** The model's generation matters more than the input
size (4.3 s against 9.0 s on the same 8k input), and 96k of input still finished in 7.4 s — the
growth with input is gentle.

Rejections are fast: 0.1 s for a format validation failure, 2.9–4.2 s for exceeding the context
(upload included).

### 15. Re-measured on the target catalogue

Everything measured on the other catalogue was measured again on the target catalogue (298
datasets / 2,608 resources, all `active`). The inventory came from the public API; no inference
was run.

**Not one resource was excluded by a cap.**

| Format          |     Files | Median |     Max | Material                         | Abstracts |
| --------------- | --------: | -----: | ------: | -------------------------------- | --------: |
| CSV             |     2,553 |   6 KB | 78.1 MB | Schema + 5 sample rows           |     2,541 |
| ZIP             |        19 |  39 KB | 81.3 MB | File listing                     |        19 |
| JPEG            |        19 | 8.2 MB |  9.7 MB | The file, scaled to 1600px       |        19 |
| ZIP (shapefile) |        16 |      — |       — | Not yet fetched (pipeline error) |         0 |
| DOCX            |         1 | 325 KB |  0.3 MB | The file itself                  |         1 |
| **Total**       | **2,608** |      — |       — | —                                | **2,580** |

**Coverage is 98.9%, and all 28 resources without an abstract failed upstream** (21 errors, 6
unprocessed, 1 queued). **Decision 3's caps (4 MB / 50 pages / 1 MB / 5 MB) excluded none of
them** — the exclusions are a data problem, not a design one. The largest block is 16 shapefile
ZIPs, which is ADR-052's territory.

**There is not one PDF and not one spreadsheet.** Neither the page cap nor the error path has
anything to do here. Ten CSVs exceed 4 MB (the largest 78.1 MB), and all are covered because
CSVs are never handed over whole.

Cost comes to **5.79M input and 0.77M output tokens**: **$9.66** small, **$19.32** medium,
**$48.30** large. The material is small enough that **output is 40% of the bill**.

#### Resources per package — decision 6's basis fell

|         | Other catalogue | Target catalogue | Concatenated at 300 chars |
| ------- | --------------: | ---------------: | ------------------------: |
| Median  |               3 |                1 |                       500 |
| Mean    |             3.6 |          **8.9** |                         — |
| p90     |               — |               25 |                     7,700 |
| **Max** |          **19** |          **102** |                **30,800** |

**28 of 294 packages (10%) exceed 8,000 characters.**

And they are **not repetitions of one thing**. The three largest are fire-service statistical
yearbooks whose hundred-odd tables are **each on a different subject**.

> Table 1 fire-safety premises · Table 2 buildings of five storeys or more · Table 5 underground
> shopping districts · Table 6 filings for fire and disaster prevention managers · Table 7
> premises with in-house fire brigades …

Truncating loses 76 subjects from the vector, and integration would shave off each table's own
vocabulary instead. **Folding a hundred subjects into one vector is the problem itself** — the
strongest evidence yet for decision 8's per-resource vectors.

#### What Phase B still needs elsewhere

**The material axis (original handover against extracted text) cannot be tested on this
catalogue** — it holds no PDFs. It needs a catalogue with figure-driven PDFs, or documents
fetched from outside.

### 16. Phase B — three axes: material, model, wording

Nine PDFs from the demo catalogue, stratified by characters per page (0 / 344 / 611 / 759 /
1,066 / 1,222 / 1,259 / 1,612 / 2,074).

#### Material — original handover versus extracted text

| Chars/page |  Pages | Original input | Text input |   Ratio | Verdict                 |
| ---------: | -----: | -------------: | ---------: | ------: | ----------------------- |
|      **0** |      5 |          8,234 |        359 |    22.9 | **Original only**       |
|        344 |      5 |          9,787 |      2,102 |     4.7 | Text as good or better  |
|        611 |      5 |         10,782 |      3,171 |     3.4 | Original slightly ahead |
|        759 |     20 |         46,729 |     15,060 |     3.1 | Even                    |
|      1,066 |      3 |          8,192 |      3,449 |     2.4 | Even                    |
|      1,222 |     17 |         46,076 |     14,838 |     3.1 | Text as good or better  |
|      1,259 |      3 |          8,897 |      4,351 |     2.0 | Text as good or better  |
|      1,612 | **44** |    **128,154** |     13,723 | **9.3** | Even                    |
|      2,074 |      1 |          3,987 |      2,390 |     1.7 | Even                    |

**Where there is a text layer, handing the original over buys nothing.** On a 44-page traffic
accident report the original cost 128,154 tokens, and the text-based output was the more
specific of the two (it named per-police-station and per-municipality accident rates the
original's did not). A table of contents behaved the same way: **the text layer carries the
contents verbatim, while the original handover re-reads them from page images.**

Only the file with an empty text layer reversed it. There the text arm wrote:

> This is a PDF file, but no text could be extracted, so its specific contents cannot be
> confirmed. (…) It cannot be judged without consulting the original.

— **a correct declaration, with no fabrication.** The original arm read the per-town population
table accurately, down to 91,798 households, 88,207 men, 96,366 women, 184,573 in total.

The original arm also wrote "as of 1 September Reiwa 8", where the resource name says "as of
1 June Reiwa 8". The PDF metadata gives `/Title: 町別人口表2026.9.pdf`, created 2026-09-03, so
**the document is the September edition and the resource name is stale** — the **second** case
of an abstract exposing a metadata error, though deciding which is right takes a person.

#### Model — the small model read it

**The small model also read the same text-layer-free PDF accurately** (same date, same range of
town names, household counts matching). The document the small model fabricated in Appendix 5
was a degraded scan of 1934 vertical old-form print; this one is crisp modern type from
`Microsoft: Print To PDF`. **Failing to extract and being hard to read are separate axes**, and
characters per page cannot tell them apart (decision 6).

The small model is **imprecise even where it reads**. From a crime statistics table it wrote
that older people are "the **majority**" of victims; the larger model wrote from the same
material that the share "**varies greatly by category**". The statements conflict, and the
former is the one that goes beyond the material.

#### Wording — the abstract carries it, the glosses add on top

Cosine similarity with Cohere embed-v4 over 5 demo resources and 16 queries.

| Comparison                                                      |                           Mean |
| --------------------------------------------------------------- | -----------------------------: |
| Metadata only → abstract (no glosses)                           |                     **+5.5pt** |
| Abstract (no glosses) → abstract with explicit everyday glosses | **+1.7pt** (15 of 16 improved) |

Individually, "a hospital where I can register my dog" gained 15.1pt and "bicycle theft" 12.2pt.
The gloss increment was smaller than Appendix 6's (~+10pt), because **the larger model glosses
unprompted** — "crime rate (recognised cases per 100,000 population)" appeared in a no-gloss
output too. **The instruction earns its keep only where the model does not do it on its own.**

#### Length — character counts are ignored; sentences and purpose are not

The same 6 resources under three instructions.

| Instruction             | Characters              | Sentences       | Over 300 | Ends on a full stop |
| ----------------------- | ----------------------- | --------------- | -------: | ------------------: |
| 200–300 characters      | 319 385 391 342 356 297 | 5 6 3 5 5 4     |      5/6 |             **6/6** |
| 3–4 sentences           | 361 330 431 329 336 319 | **4 4 4 4 4 4** |      6/6 |             **6/6** |
| 3–4 sentences + purpose | 219 317 337 291 342 266 | 4 4 3 4 4 4     |  **3/6** |             **6/6** |

**Sentence counts are honoured exactly, and stating the purpose shrinks the output** (353 → 295
characters on average). And **all 18 measured outputs ended on a full stop** — text breaks
mid-sentence only when we break it by character count.

### 17. The model itself decides an abstract needs no reasoning

Every Bedrock Converse parameter that looked like a control on generation was measured. **Only
the prompt worked.**

| Parameter            | Bedrock                       | Decision here                                                                     |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `maxTokens` (output) | ✅ in use (default 2,048)     | **A ceiling against runaway output.** Not a length control — it cuts mid-sentence |
| An input-token cap   | ❌ does not exist             | Byte and page caps stand in (decision 3)                                          |
| `thinking`           | ✅                            | **Not used**                                                                      |
| `effort`             | ✅ but not on the small model | A dial on thinking depth — **nothing to act on** with thinking unused             |
| Length               | —                             | **Sentences and purpose, in the prompt** (decision 7)                             |

#### `thinking` — the abstract shrinks 8%, the bill doubles

Four runs each on the medium model, counting the abstract and the reasoning separately with
`CountTokens`.

|            | Billed output | Abstract | Reasoning |
| ---------- | ------------: | -------: | --------: |
| off        |       **236** |      232 |         0 |
| adaptive   |       **478** |  **213** |       246 |
| Difference |     **+103%** |  **−8%** |      +246 |

**"Think first and the writing tightens" does happen.** But 19 tokens off the abstract cost 246
tokens of reasoning — thirteen times the price. Decision 7's sentences-and-purpose instruction
gets twice the compression (−16%) for nothing.

**Quality showed no improvement either.** From material holding five rows of one account, one
thinking run wrote:

> The data covers **several account categories** including the general account, **spanning** a
> broad range of expense headings

Neither is in the material (pass criterion 1). All three no-thinking runs hedged correctly —
"**at least** the 2024 general account", "in the data **visible as a sample**". At four against
four this does not establish that thinking increases fabrication, but **no evidence appeared that
it suppresses it**.

Applied to the target catalogue, output goes from 0.77M to roughly 1.56M tokens — **$19.32 to
$27.1 (+40%)** on the medium model. Output is 40% of that catalogue's bill (Appendix 15), so
doubling it is expensive.

#### `effort` — it is a dial on thinking depth

It goes in `additionalModelRequestFields.output_config.effort`, not `inferenceConfig`. **With
thinking off it does nothing** — there is no reasoning to scale, and measuring it in that state
first, then concluding it "does not work", was an error in the measurement's design. Re-measured
with thinking on, it **moves monotonically** (medium model, three runs averaged).

| Setting                   | Billed output | Abstract | Reasoning |
| ------------------------- | ------------: | -------: | --------: |
| thinking off / no effort  |           240 |      236 |         0 |
| thinking off / effort low |           221 |      217 |     **0** |
| thinking off / effort max |           255 |      251 |     **0** |
| **on** / effort **low**   |       **230** |      226 |     **0** |
| **on** / effort medium    |           275 |      224 |        31 |
| **on** / no effort        |           482 |      218 |       253 |
| **on** / effort high      |       520–550 |      226 |       259 |
| **on** / effort max       |     989–1,402 |      200 |   353–385 |

The three thinking-off rows wander between 217 and 251 as **noise**, not as a response to effort
(reasoning is 0 throughout).

**The row that matters is `on / low`, where reasoning falls to 0.** Its 230 billed tokens match
the 240 of thinking-off, meaning **adaptive thinking decides for itself that the task has no room
to think in**. The abstract barely moves from `low` to `high` (218–226); only `max` shortens it,
to 200, at up to six times the bill and with wide spread (reasoning 288–434).

> **The default — no thinking — is the state the model picks for itself.**

The accepted values differ by model. **The small model (Haiku 4.5) rejects the parameter
outright** (`This model does not support the effort parameter.`, on `jp.` and `global.` alike).
The medium model (Sonnet 4.6) rejects `xhigh`; only the large model (Opus 4.7) takes all five.
The small model is a generation behind on thinking too: it rejects `adaptive` and takes only
`budget_tokens`.

#### Why

**Writing an abstract is reading, not reasoning.** Read the material, produce three or four
sentences — there is little room to think. So raising effort leaves the abstract unchanged, and
made to think, the model instead **fills in what the material does not say**. ADR-040 found the
same direction (on a local model, thinking was 5.4× slower and worse). That two different models
and generations agree suggests **the shape of the task is what decides it**.

### 18. Phase C — the Nova models cannot be used (2026-09-14)

**An order of magnitude in price is worth measuring.** The Amazon models usable for abstracts in
the Tokyo Region, beside Claude (AWS Price List API, on-demand standard, per 1M tokens).

| Model             |     Input |    Output | Generation | `jp.*` profile |
| ----------------- | --------: | --------: | ---------- | -------------- |
| Nova Micro        |     $0.04 |     $0.17 | 1          | ✗              |
| Nova Lite         |     $0.07 |     $0.29 | 1          | ✗              |
| Nova Pro          |     $0.96 |     $3.84 | 1          | ✗              |
| **Nova 2.0 Lite** | **$0.36** | **$3.01** | 2          | ✓              |
| Claude Haiku 4.5  |     $1.10 |     $5.50 | —          | ✓              |
| Claude Sonnet 4.6 |     $3.30 |    $16.50 | —          | ✓              |

**On a deployment that promises domestic processing, Nova 2.0 Lite is the only Nova available.**
The other three have only `apac.*` (destinations across all of Asia Pacific), which is ruled out
for the same reason `global.*` is (the cost section). Nova Pro costs **more** than Nova 2.0 Lite,
so it could only be chosen by being clearly better.

#### Capability — document blocks go through, forced JSON does not

A one-page PDF sent as a Converse document block.

| Model            | Document block | Forced JSON via tool use                                           |
| ---------------- | -------------- | ------------------------------------------------------------------ |
| Nova 2.0 Lite    | Works          | **Breaks.** No `toolUse`; a pseudo-XML string in the text          |
| Nova Pro         | Works          | **Degenerates.** Drops `required` keys, returns the title verbatim |
| Claude Haiku 4.5 | Works          | Correct                                                            |

Nova 2.0 Lite returned `<tools><__function=resource_abstract>…` as text, and reported no token
usage. **An implementation that expects a `toolUse` block always fails on Nova.**

#### Tokens — Nova 2.0 Lite alone is a sixth

Input tokens for the same one-page PDF.

| Model            | Input tokens |
| ---------------- | -----------: |
| Nova 2.0 Lite    |      **289** |
| Claude Haiku 4.5 |        1,657 |
| Nova Pro         |        1,741 |

Appendix 2 measured 1,985–3,078 tokens a page for PDFs, dominated by the page images.
**Nova 2.0 Lite being an order cheaper suggests it reads the text layer rather than the page
images** — which would make its cheapness and its blindness to scans the same fact. The next
measurement bears that out.

#### Quality — the scans settled it

The same page was produced as two PDFs with no text layer (crisp print, and a degraded scan:
low resolution, skew, paper noise, low contrast) and run with the two real resources through
four models, on the production prompt. The truth is 1,204 for the lightest care level and 10,223
in total, with 78.4% home and 21.6% residential service use.

| Model             | Clean scan                 | Degraded scan                    |
| ----------------- | -------------------------- | -------------------------------- |
| Nova 2.0 Lite     | Reads it, mangles terms    | **Fabricates**                   |
| Nova Pro          | **Fabricates**             | **Fabricates**                   |
| Claude Haiku 4.5  | Nearly correct (imprecise) | Nearly correct (small errors)    |
| Claude Sonnet 4.6 | Correct                    | **Reads every figure correctly** |

**Nova Pro did not read even the clean scan.** It produced no figures at all and wrote that the
survey "covers health, living conditions and use of care services" and is "broken down by age,
sex and district" — none of which is on the page. **It wrote from the `datasetContext` title and
notes alone.**

**Nova 2.0 Lite collapses once the page degrades**, inventing a monitoring centre and paper and
electronic response collection. Even on the clean scan it coined a term that does not exist.

**Sonnet 4.6 read all seven care levels and both utilisation rates off the degraded scan.**

**Nova goes beyond the material on text material too.** Given a PDF of a statistical table with a
text layer, Nova 2.0 Lite wrote that it is "graphed with people on the vertical axis and years on
the horizontal" — the material is a table of figures and says nothing about axes. Haiku and
Sonnet both called it a table.

#### An abstract that writes about its material (2026-09-14)

A failure from real data. Of a latitude and longitude column, a generated abstract wrote:

> The latitude and longitude columns were all null **in the sample rows**.

**Faithful to the material, and unreadable.** The reader does not know sample rows exist, or
that there were five of them out of 163. Five nulls say nothing about the rest.

Decision 7's prohibition binds what a claim may rest on; it did not bind what a claim may be
_about_. Hedging with "in the sample rows" slips past it and produces a meaningless sentence. One
rule was added:

> **Write about the file, never about the material you were given.** The reader is shown
> separately how much of the file was read and cannot tell what "the sample rows" or "the
> extracted text" refers to. In particular, do not report a column as empty, constant or null
> because the rows you were given are. Say nothing about a column you cannot characterise.

**The notice now answers the question that leaves open.** Decision 7's own example ("from the
opening pages of 87") assumed the extent would be stated, and the implementation had dropped it.
How much was read is recorded per material and shown — "the column layout and the first 5 of 163
rows". **If the model may not name the material, the page has to.**

The version is also spelled as the history spells it (`v4`), and **a version older than the one
the resource serves is called out** — leaving a reader to compare two numbers was a weak reading
of "the state where a file moved on and the abstract did not is visible".

#### Sonnet 5 — `global` only in Tokyo (2026-09-14)

Measured against Sonnet 4.6 on the prompt above (version 2), same four materials.

**Availability first.** ap-northeast-1 lists `global.anthropic.claude-sonnet-5` and **neither a
`jp.` nor an `apac.` profile**. A geo rate is published, so the pricing is settled and the
geography-limited profile has not arrived here.

|                    |     Input / output | Destinations                    |
| ------------------ | -----------------: | ------------------------------- |
| `jp.` Sonnet 4.6   |     $3.30 / $16.50 | ap-northeast-1 / ap-northeast-3 |
| `global.` Sonnet 5 | **$2.00 / $10.00** | every commercial Region         |

**40% cheaper.** What is traded is not money but the property the cost section names: keeping the
processing inside one country. **On a deployment that promises that, it is not an option yet.**

**Quality is close, and Sonnet 5 is the more concise.**

| Material              | Sonnet 4.6 | Sonnet 5 |
| --------------------- | ---------: | -------: |
| CSV                   |  253 chars |      244 |
| PDF with a text layer |        248 |      234 |
| Clean scan            |        243 |      205 |
| Degraded scan         |        290 |      212 |

**Sonnet 5 read the degraded scan correctly too** — 10,223 in total, 78.4% home against 21.6%
residential — the condition both Nova models fabricated on. The difference is in specificity:
Sonnet 4.6 lists the figures, Sonnet 5 says the section explains them. For a search vector it is
vocabulary that counts, so the gap is small.

**Both obeyed the new rule.** Nothing resembling "in the sample rows" appears in any of the eight.

**Sonnet 5 refuses `temperature`** (`temperature` is deprecated for this model). Neither this
ADR's path nor ADR-040's sends one, so nothing is affected — but `CompleteOptions.temperature`
still exists, and using it would fail.

Re-evaluate when `jp.anthropic.claude-sonnet-5` arrives.

#### Consequences

- **Decision 6 holds, and holds harder.** "The axis is generation, not size" — the larger, older
  Nova Pro is **worse** than the smaller, newer Nova 2.0 Lite
- **Nova is not used.** Routing only material that shows no image to it ("After the MVP") does
  not stand either, because of the fabrication on text material
- **Decision 3.2's everyday-gloss instruction works even on small models.** All four glossed
  the administrative terms — an improvement on Appendix 3, where small models did not
- **All four obeyed the sentence count** (decision 7)

**These are single samples, not a golden-set evaluation.** The scans are synthetic and degraded
to one arbitrary degree. Nova cannot return JSON, so the self-report flag (pass criterion 3) was
not measured.

### 19. The PDF byte cap, measured (2026-09-15)

Decision 3.3's 4 MB was a coverage figure, not a measurement of the API's limit. So it was
measured.

**Method.** Send `jp.anthropic.claude-sonnet-4-6` a PDF with the page count pinned at two,
padding the bytes with **a stream no page draws**. That separates the two axes and keeps each
successful call to about a cent (refusals are not billed).

| Size     | Result      | Input tokens |
| -------- | ----------- | -----------: |
| 3.00 MB  | accepted    |        3,158 |
| 5.00 MB  | accepted    |        3,158 |
| 12.00 MB | accepted    |        3,158 |
| 20.00 MB | accepted    |        3,158 |
| 22.30 MB | accepted    |        3,158 |
| 22.60 MB | accepted    |        3,158 |
| 22.90 MB | **refused** |            — |
| 25.00 MB | **refused** |            — |

The refusal reads `Input is too long for requested model.` and classifies as `too-long`
(decision 3.4's table).

**The boundary is about 22.7 MB.** And the input tokens holding at 3,158 from 3.00 MB to
22.60 MB is a direct confirmation of Appendix 2's "tokens are decided by page count".

**Conclusion: the byte cap does not guard cost.** It guards the API's ceiling and the worker's
memory; the page cap guards cost (note under decision 3.3).

**Only the bytes were varied.** A real request also carries the system prompt and the user
content, so if the limit applies to the whole request the usable figure is lower. The 16 MB
setting is that margin.

## Related ADRs

- ADR-040 (AI metadata suggestions) — shares material assembly and its first phase; the
  difference from the proposal shape is being automatic
- ADR-034 (metadata vector search) — where the embedding goes
- ADR-021 (full-text search over resource content) — the source of extracted text; indexing
  attributes belongs there
- ADR-046 (separating the canonical file from its interpretation) — why inference stays out of
  the interpretation path
- ADR-043 (resource versioning) — the source version, the regeneration trigger
- ADR-039 (dataset draft state) — the line that limits automatic generation to `active`
- ADR-032 (MCP data query) — why Excel does not reach it
