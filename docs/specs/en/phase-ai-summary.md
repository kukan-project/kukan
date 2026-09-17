> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase-ai-summary.md`](../jp/phase-ai-summary.md).

# Phase AI-Summary: AI-Generated Resource Abstracts — Implementation Spec

> **Goal**: give every resource a short AI-generated **abstract**, show it on the resource page,
> and add it to the material the embedding is built from. **The AI's inference is limited to
> generating the summary sentences; it never generates values a machine believes** (column types,
> primary keys, header-row positions). ADR-053 is authoritative for the design decisions.

## 1. Prerequisites

- **ADR-053's spikes, Phase A and Phase B, are done.** What remains is acceptance criterion 6
  (the before/after nDCG comparison), which needs the abstracts themselves and is therefore
  measured after this phase is implemented (§14)
- **ADR-040 (AI metadata suggestions) already has the material assembly, the per-format
  decisions, and the evaluation harness.** The abstract shares them, but **the suggestion flow's
  behavior does not change**
- **ADR-046**: the abstract is made from the version (the immutable canonical file). The same
  input always yields the same material
- **ADR-044**: generation happens under the resource's execution claim, like every other step
- **ADR-034 / the embedding debounce**: the abstract becomes an input to `embedding_hash`. One
  more link is added to the chain of dependencies (§9)
- **The Index step already persists the first 64KB of extracted text for document formats**
  (`TEXT_HEAD_ARTIFACT_SIZE`, ADR-040 addendum). **PDF extracted text uses that artifact; no new
  extraction path is built**

### 1.1 Settled items (ADR-053's open questions)

| #   | Open question              | Settled as                                                                                                 |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Generation language        | **Runtime setting** `ai-summary-locale` (ADR-036), default `ja`. Included in the abstract hash (§4.2)      |
| 2   | Exposure in the CKAN API   | **Not exposed.** Only on KUKAN's own `/api/v1` (§10.1)                                                     |
| 3   | "Empty material" threshold | The values in §7.3. Tuned during the evaluation (§14)                                                      |
| 4   | Naming the model           | **Named explicitly in `AI_SUMMARY_MODEL`** (no default). Sonnet 4.6 class recommended (ADR-053 decision 6) |
| 5   | Embedding assembly order   | Exactly ADR-053 decision 8's table. Truncation is **by sentence** (§9.1)                                   |
| 6   | The AIAdapter extension    | `CompleteOptions.attachments` + `getDocumentInfo()` (§5)                                                   |
| 7   | The concatenation cut-off  | **Accepted.** Per-resource vectors are a separate phase right after the MVP (§15)                          |

Two decisions are not in the ADR. **Both are added to the ADR as an addendum.**

| Point                   | What the ADR says                          | What this spec settles                                                                 |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| The backfill path       | Ride the existing `rebuildOnly` (dec. 4.1) | **A dedicated job type** (§11). `rebuildOnly` rebuilds every derivative                |
| How "why not" is stored | A list of columns (Impact section)         | **Two columns: `summary` + `summary_meta` (jsonb)** (§4), following `HealthCheckState` |

#### Why the backfill does not use `rebuildOnly`

`rebuildOnly` bypasses the reuse check in
[process-resource.ts](../../../apps/worker/src/pipeline/process-resource.ts)
(`!rebuildOnly && !versionCreated && derivativesDescribe(...)`), so it **regenerates every
Parquet and re-ingests all of DuckLake (a catalog-wide lock) for every resource**. The material
an abstract needs is already in storage and in the database, so that cost does not have to be
paid.

And because the abstract generation key includes the model, the generation version and the
locale, **a full
generation is not a one-off operation** — it runs again every time the prompt is tuned. Riding on
the existing "reprocess content" action would empty the full-text index each time.

No queue is added — this queue already carries nine job types, and the full embedding rebuild
(`EMBED_ALL_JOB_TYPE` → `EMBED_JOB_TYPE`) has exactly this shape. ADR-053 decision 4.3's
"dedicated queue and dedicated poller" remains a follow-up.

## 2. Architecture

There are two entry points for generation and **one implementation** (`summarizeResource()`).

```
Incremental (ADR-053 decision 4)
[Worker] resource-pipeline job
  Fetch → Version → Interpret → Lake → Index → Summarize  ← added (best effort)
                                                    └─ when the abstract changed,
                                                       enqueueEmbeds (through the debounce)

Backfill (§11)
[API] POST /api/v1/admin/generate-summaries
  └─ summarize-all job
        └─ one summarize-package job per package
              └─ processes one ungenerated resource, then requeues itself
                 when none remain, enqueues embed-package once and ends
```

**The backfill is a per-package serial chain for three reasons.**

- **Visibility timeout.** One job = one resource (3–11s). Running a package in a single job would
  take up to 18 minutes for a 102-resource package, and a redelivery would bill the same
  generation twice
- **It prevents a partial embedding.** The embedding debounce is **leading-edge**: a change that
  arrives inside the 60-second window is dropped
  ([search-index.ts](../../../packages/api/src/services/search-index.ts), `enqueueEmbeds`).
  Fanning out per resource could settle a package's vector on only the first of its 102
  abstracts. Per package, the window is never hit
- **Completion is self-evident.** "Nothing left" is the terminal condition — no counter, no flag

## 3. What gets generated, and from what

### 3.1 Material per format (ADR-053 decision 3)

> **The original is sent only when there is no other way to get at the content.**

| Format                      | Material                                      | Source                           |
| --------------------------- | --------------------------------------------- | -------------------------------- |
| CSV / TSV                   | Schema (column names + types) + 5 sample rows | The version's `schema` + preview |
| Text formats                | Head of the stored original                   | The version's object             |
| ZIP                         | File listing                                  | The Interpret manifest           |
| GeoJSON                     | First features' properties + feature count    | The version's object             |
| **PDF (with a text layer)** | **Extracted text**                            | The Index text-head artifact     |
| **PDF (thin text layer)**   | **The original, as-is**                       | The version's object             |
| **XLSX / XLS / DOC / DOCX** | **The original, as-is**                       | The version's object             |
| **Images**                  | **The original; downscaled above 5MB**        | The version's object             |
| PPT / PPTX                  | **Extracted text** (no original can go)       | The Index text-head artifact     |

**A format whose original cannot go is read from its extracted text.** No provider lists PPT, but
Index extracts and stores text for every format `isDocumentFormat` covers. Being unable to send
the original does not mean there is no material, so the order is **original, then extracted text,
then out of scope** (an addendum to ADR-053 decision 3.4). Office formats themselves still send
the original.

**PDFs are routed on characters per page.**

```
extracted characters / page count >= 100  → extracted text (material: 'text-head')
                                  < 100  → send the original (material: 'original')
page count unreadable                     → send the original
```

Page count is read with `pdf-lib` (pure JS, no rasterizer). The extracted text is the artifact
Index has already persisted. **Where a text layer exists, extracted text is 1.7–9.3× cheaper and
the output is at least as good** (ADR-053 appendix 16).

### 3.2 Limits (ADR-053 decisions 3.3 / 3.4)

| Format                  | Limit                                | Measurable in advance | Above it              |
| ----------------------- | ------------------------------------ | --------------------- | --------------------- |
| CSV / text / ZIP        | **None** (the original is not sent)  | —                     | —                     |
| PDF (with a text layer) | **None** (extracted text is sent)    | —                     | —                     |
| PDF (original sent)     | **16MB**                             | Yes                   | extracted text, or no |
| PDF (original sent)     | 50 pages                             | Yes                   | **send the first 50** |
| XLSX / XLS / DOC / DOCX | 1MB **+ send it and read the error** | No                    | no                    |
| Images                  | 5MB (the API's hard limit)           | Downscale above it    | downscale             |

**The PDF byte limit is 16MB.** As the note under ADR-053 §3.3 records, the original 4MB was a
coverage figure answering neither question the limit exists for. Measured, 3MB and 22.6MB both
bill 3,158 input tokens and 22.9MB is refused (ADR-053 Appendix 19). **Bytes do not buy
tokens.** What 16MB guards is the API's ceiling (about 22.7MB) and the worker's memory.

**A PDF past the page limit is not refused: its first 50 pages are sent** (ADR-053 §3.7).
Tokens follow pages, so the 50-page limit is already the ceiling on one file; cutting to it
costs exactly what accepting a 50-page document costs, and refusing buys nothing.

**An encrypted PDF cannot be cut** (ADR-053 §3.8). `pdf-lib`'s `ignoreEncryption` parses the
structure without decrypting it, so `copyPages` produces blank pages. `isEncrypted` refuses the
cut — **counting pages is safe; taking them out is not.**

**Size limits apply only to formats whose original is sent.** A CSV uses its schema and sample
rows, so its material is constant even at 78MB. Tabular formats are judged on whether a schema
exists.

**Images above 5MB are downscaled to 1600px on the long edge** with `sharp` (libvips). JPEG
shrink-on-load applies, taking peak RSS from 365MB to 105MB on an 8,256 × 5,504 photo. Very large
PNGs are a follow-up (§15).

### 3.2.1 The text-layer test must look at the read cap

Whether a PDF uses extracted text or the original is decided on characters per page (threshold
100). **That ratio only means anything when the read came in under its cap.**

The extracted text is read up to `SUGGEST_TEXT_HEAD_BYTES` (16,384). In Japanese that is about
5,400 characters, so dividing by a document's total page count makes **every PDF past about 54
pages read as thin** — measuring the cap rather than the file (note under ADR-053 §3.6).

```
read filled the cap   → the layer is dense (filling it is the proof) → extracted text
read came in short    → it is all there was → characters ÷ pages decides
page count unreadable → extracted text (only our own parser failed)
```

### 3.3 Metadata is attached as context (ADR-053 decision 3.2)

It is passed as `datasetContext`, **kept apart** from the resource's own material.

```jsonc
{
  "datasetContext": {
    "title": "...",
    "organization": "...",
    "tags": ["...", "..."],
    "notes": "first 400 characters",
  },
  "resource": {/* the same shape as ADR-040's serializeResource */},
}
```

`notes` is the most effective and the most likely to induce parroting, hence the cap. **Metadata
is context, not material** — a resource with no material is not "generatable because it has
metadata".

## 4. Data model

### 4.1 Columns

Two columns are added to `resource` (28 → 30). Folding internal state into jsonb is the same
treatment `HealthCheckState` gets.

```typescript
// packages/db/src/schema/resource.ts
summary: text('summary'),
summaryMeta: jsonb('summary_meta').$type<ResourceSummaryMeta>().notNull().default({}),
```

```typescript
export interface ResourceSummaryMeta {
  /** 'ai' = generated, 'human' = an editor overrode it */
  source?: 'ai' | 'human'
  /** An editor hid it. Generation, display and embedding all stop */
  hidden?: boolean
  /** The version it was generated from (ADR-043). Shown in the notice */
  version?: number
  /** What it was made from. Decides the wording of the notice */
  material?: 'schema' | 'text' | 'text-head' | 'original' | 'image' | 'files'
  /** How much was read, so the notice can say "the first M of N" */
  coverage?: SummaryCoverage
  generatedAt?: string
  /** Why nothing was generated. Shown on the page */
  skipReason?: SummarySkipReason
  // --- below here, only the worker reads. Never in the public projection ---

  /** model ‖ generation version ‖ locale (§4.2). Says only whether the writing changed */
  genKey?: string
  model?: string
  /** The model's self-report ("was the material enough"). Recorded and measured only */
  grounded?: boolean
  /** The token count an over-limit rejection returned. The second attempt is refused up front */
  rejectedTokens?: number
}
```

```typescript
export interface SummaryCoverage {
  /** Rows, characters, file names or pages actually read */
  read?: number
  /** How many there are in total, where the material says */
  total?: number
}
```

**`coverage` exists for the notice.** The model is forbidden to mention its material (ADR-053
decision 2), so a reader cannot tell "all of it" from "the first few rows of it". Saying which
is this number's job (§10.3).

**An original sent whole carries no coverage.** "All of it" is what the absence already says;
only an original sent in part — a PDF past the page limit — carries one.

**`genKey`, `model`, `grounded` and `rejectedTokens` are never published.** As
with `extras` and `scrubbedExtras`, the public projection lives in exactly one place
(`packages/db/src/schema/resource.ts`, `publicSummary` / `publicSummaryMeta`), and
`summary_meta` is never returned whole. It is spelled in the projection rather than per route
because **a response that forgets is a response that publishes text someone took down**.

`hidden` and `source` are not columns because **neither is ever used to filter**. Both the
embedding assembly and the public projection decide after reading the row (§9.1).

### 4.2 Two keys: the version and the generation

```
version = the version the abstract was written from (resource_version.version)
genKey  = model ‖ generation version ‖ locale
```

|                          | same version                  | different version |
| ------------------------ | ----------------------------- | ----------------- |
| **same generation**      | do nothing                    | generate          |
| **different generation** | generate only under `refresh` | generate          |

An ordinary run looks at the version alone. Only an explicit `refresh` from the admin screen
reacts to a change in how abstracts are written (§11.2). **It compares rather than ignores, so
pressing it twice is free.**

- **Version**: the abstract stands while its version does. Re-running the same version — a
  content reprocess (`rebuildOnly`), a retry, a periodic re-enqueue — **costs nothing**

  > **The material itself must not be the digest.** Hashing the facts the model was told lets an
  > internal change of the pipeline — Interpret adding column statistics, a settled version
  > re-issued to carry a format — **regenerate the whole catalogue without appearing in the
  > estimate** (ADR-053 decision 9). What the model is shown for the same file changes only
  > when the code does, and that is a decision, not a fact to reflect automatically.

- **Generation version**: the `SUMMARY_GENERATION_VERSION` constant. **Raised by the PR that
  alters what the model is shown for the same file, or how it is asked** — the prompt and its
  locale addenda, the size and page limits, how a material is chosen, an extraction improvement
  the abstracts should reflect. Not by a refactor or a UI change; a model switch moves the other
  half of the genKey
- **Locale**: switching it makes every abstract stale, but **nothing regenerates automatically**.
  The admin screen states that a mixed-language period follows (§10.3)

### 4.3 When nothing is generated (ADR-053 decision 5)

| `skipReason`           | Condition                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `disabled`             | `AI_SUMMARY_MODEL` is unset (**nothing is recorded**, §7.1)                        |
| `provider-unavailable` | `getCompletionInfo()` returns null                                                 |
| `unsupported-format`   | The provider takes no original and there is no extracted text either               |
| `too-large`            | Over the size or page limit, or `size` is unknown                                  |
| `rejected`             | Sent and refused with `ValidationException` (permanent); `rejectedTokens` recorded |
| `no-material`          | The material is empty (§7.3)                                                       |
| `not-public`           | The package is not `active` (draft or private)                                     |
| `hidden`               | An editor hid it                                                                   |

**A transient failure (throttling, 5xx, timeout) must never be written as a `skipReason`.** It is
recorded as a step failure and retried on the next run.

## 5. Step 1: extending the AIAdapter

`packages/adapters/ai/src/adapter.ts` currently takes only a prompt string.

```typescript
export interface CompletionAttachment {
  kind: 'document' | 'image'
  /** 'pdf' | 'xlsx' | 'png' … the adapter maps it onto the provider's enum */
  format: string
  /** The name given to the provider; enough to tell where the material came from */
  name: string
  bytes: Uint8Array
}

export interface CompleteOptions {
  // existing fields unchanged
  attachments?: CompletionAttachment[]
}

/** null where originals cannot be sent (same shape as getEmbeddingInfo()) */
export interface DocumentInfo {
  documentFormats: string[]
  imageFormats: string[]
  maxImageBytes: number
}
```

`AIAdapter` gains `getDocumentInfo(): DocumentInfo | null`.

| Adapter | `getDocumentInfo()`                                                                 |
| ------- | ----------------------------------------------------------------------------------- |
| bedrock | `csv/doc/docx/html/md/pdf/txt/xls/xlsx` + `gif/jpeg/png/webp`, `maxImageBytes: 5MB` |
| openai  | **null** (originals are not sent in the MVP)                                        |
| ollama  | **null**                                                                            |
| noop    | **null**                                                                            |

**The application layer never branches on provider name** (ADR-005). Where it is `null`, tables
and text get abstracts and PDFs do not — treated as **a difference in supported formats**, not as
the feature being absent.

### 5.1 Classifying errors

Over-limit and unsupported-format are **permanent**; throttling is **transient**. If the
application layer cannot tell them apart, a transient failure gets recorded as "out of scope"
(ADR-053 decision 3.4). The adapter classifies and throws.

```typescript
export class AiInputRejectedError extends Error {
  /** The token count the over-limit error returned (`prompt is too long: N > M`) */
  readonly actualTokens?: number
  readonly reason: 'too-long' | 'unsupported-format'
}
```

Throttling and 5xx are rethrown as-is; the caller retries with exponential backoff.

## 6. Step 2: shared — env, runtime setting, constants

### 6.1 Environment variable (ADR-053 decision 10)

```typescript
// packages/shared/src/env.ts
AI_SUMMARY_MODEL: z.preprocess(emptyAsUndefined, z.string().optional())
```

**Naming the model is the switch.** Unset, nothing is written and nothing is spent. **Clearing it
again does not delete the abstracts already generated.**

**The flag and the model are not separated.** They are one decision — what this deployment will
spend on abstracts — and separating them creates an "enabled but no model chosen" state that
something has to reconcile.

**And choosing a model is not a free setting.** It is a threefold difference between Sonnet 4.6
and Haiku 4.5, and ninefold against Nova. Decision 10's reason for putting the switch in the
environment — the cost falls on whoever deploys the site, not on whoever would flip it —
**applies to the model unchanged**.

**A model outside the allow-list is refused, not replaced by a default.** The default is only
whatever comes first in `AI_COMPLETION_MODELS`, and ADR-053 appendix 18 measured what the wrong
model there does: **not worse abstracts, invented ones.**

### 6.2 Runtime setting

```typescript
// packages/api/src/services/system-setting.ts
export const AI_SUMMARY_LOCALE_KEY = 'ai-summary-locale'
[AI_SUMMARY_LOCALE_KEY]: { schema: z.enum(['ja', 'en']), default: 'ja' },
```

The choice of language does not affect cost, so it can be the site administrator's. **It is not
shown in the settings UI on a site with no model configured** (§10.3). The asymmetry explains
itself: **language is free, the model is money.**

> **This is the first time the worker reads a runtime setting.** `SystemSettingService` is used
> only by the API side today. The worker already imports from `@kukan/api/services/*`, so
> nothing structural is in the way, but it sets a precedent worth recording. It has a short-TTL
> cache, so a change propagates within that TTL.

### 6.3 Constants

```typescript
// near packages/shared/src/formats.ts
export const SUMMARY_MAX_DOC_BYTES = 4 * 1024 * 1024
export const SUMMARY_MAX_OFFICE_BYTES = 1 * 1024 * 1024
export const SUMMARY_MAX_PDF_PAGES = 50
export const SUMMARY_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const SUMMARY_IMAGE_RESIZE_PX = 1600
export const PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE = 100
export const SUMMARY_MIN_MATERIAL_CHARS = 50
```

### 6.4 The pipeline step name

`'summarize'` is added to `PipelineStepName` (`packages/shared/src/pipeline-types.ts`). The UI
labels (ja/en) and `docs/pipeline.md` are updated with it.

## 7. Step 3: Summarize — the implementation

`summarizeResource()` lives in `apps/worker/src/pipeline/steps/summarize.ts` and is shared by the
pipeline step and the backfill job.

### 7.1 Order of decisions

```
AI_SUMMARY_MODEL unset                 → do nothing (record nothing)
getCompletionInfo() is null            → skipReason: 'provider-unavailable'
package is not active                  → skipReason: 'not-public'
summary_meta.hidden                    → skipReason: 'hidden'
summary_meta.source === 'human'        → do nothing (never overwrite a person's text)
plan the material (format, limits, artifacts) → skipReason where none can be had
compare version / genKey               → per the table in §4.2
a standing refusal of the same input   → do nothing (carry the version forward)
─────────────────────────────────────
call the LLM → write the result
```

Nothing is written while no model is configured because **it can all be made later by
reprocessing** (ADR-053 decision 10).

**Each kind of material is gated on the step that wrote what it reads.** They do not come from
the same place.

| Material kind        | Reads                | Gated on    |
| -------------------- | -------------------- | ----------- |
| table (CSV / TSV)    | schema + sample rows | Interpret   |
| archive (ZIP)        | the manifest         | Interpret   |
| document (ODT / RTF) | the extracted text   | **Index**   |
| text                 | the object itself    | **neither** |

Asking Interpret for all of them breaks two things. **A run whose Index failed describes a
document with the previous version's extracted text** — the artifact is still on the row. And
**a text file whose interpretation merely failed is called material-less**, when its object is
settled bytes owing nothing to any step (ADR-046).

**Sample rows are an enhancement on a table's schema, not its material.** The query path
refuses a resource with no preview, which is a fact about the resource rather than a failed
read. Losing them must not cost the schema, and must not reach the caller: the suggestion
degrades the whole resource to its metadata, and the pipeline step fails its job, which has the
queue retry the same package for ever.

### 7.2 What must hold (ADR-053 decision 4.2)

- **No DB transaction stays open across the LLM call.** Take the claim → commit → call the LLM →
  write the result. The worker's pool is `WORKER_DB_POOL_MAX` = 3
- **The visibility timeout must exceed the worst-case latency plus backoff.** Too short and the
  message is redelivered, **billing the same generation twice**. The current value is checked
  during implementation and raised if needed
- **Exponential backoff on 429.** A backfill will hit it
- Best effort. **A failure is recorded as a step failure and never fails the pipeline**

### 7.3 The "empty material" values

| Material        | Counted as empty when                                        |
| --------------- | ------------------------------------------------------------ |
| Tabular         | `schema.columns.length === 0` (no schema)                    |
| Text / document | Fewer than `SUMMARY_MIN_MATERIAL_CHARS` non-space characters |
| ZIP             | The file listing is empty                                    |
| Images          | Never empty (there is an original)                           |

Tuned during the evaluation (§14). **This value doubles as the observation point** for "are many
resources showing a reason instead of an abstract" (ADR-053 decision 5).

### 7.4 The step decides reuse for itself

The pipeline skips Interpret and Index together via `derivativesReused`. **Summarize does not
ride that**; it decides from its own hash.

That is what makes **an ordinary pipeline run a backfill once the feature is enabled** — a
resource whose content has not changed still gets an abstract if it has none.

## 8. Step 4: material assembly and the prompt

### 8.1 Material assembly moves out of `suggest/`

Assembly is currently private to
[metadata-suggest-service.ts](../../../packages/api/src/services/metadata-suggest-service.ts).
It becomes `collectResourceMaterial()` in
`packages/api/src/services/suggest/materials.ts` so the worker can call it.

**Kept as a behavior-preserving refactor in its own commit.** `readSampleRows`, `readTextHead`,
`readArtifactTextHead` and `readZipFileList` move as they are.

### 8.2 The prompt

`packages/api/src/services/suggest/summary-prompt.ts` (new). ADR-040's
`buildResourceSystemPrompt` is not touched.

- **`GROUNDING_RULES` is shared verbatim** (every proper noun grounded in the material or in
  existing metadata)
- **Length is specified in sentences, not characters, with the reason attached.** "3–4 sentences",
  "because it has to fit a budget on a search vector". In Phase B a character count was exceeded
  in 5 of 6, a sentence count held in 6 of 6, and adding the purpose shrank the average from
  353 to 295 characters
- **Claims beyond the material are forbidden** — especially periods, counts, maxima and minima
  inferred from 5 sample rows
- **Technical and administrative terms carry an everyday gloss in parentheses**
- **`datasetContext` is given a role** — context and grounding for proper nouns, not a paraphrase
  of the metadata
- **A per-locale addendum block.** The shared part is written in English, with `ja` / `en`
  addenda for the language-specific parts (how the everyday gloss is written, and so on).
  **Changing an addendum bumps `SUMMARY_GENERATION_VERSION`**

The output is forced JSON.

```typescript
{ summary: string, groundedInMaterial: boolean }
```

`groundedInMaterial` is **recorded and measured only**. In Phase A, a small model given a scanned
PDF never said it could not read it — **this flag cannot catch fabrication** (ADR-053
decision 5). It never switches a path.

## 9. Step 5: feeding the embedding

### 9.1 Assembly order (ADR-053 decision 8)

`buildEmbeddingText` in [embed-package.ts](../../../apps/worker/src/embed/embed-package.ts) is
replaced. **Nothing existing is dropped.**

| Order | Content                                             |
| ----- | --------------------------------------------------- |
| 1     | title / notes / tags / section labels               |
| 2     | **The concatenated abstracts (200–300 chars each)** |
| 3     | Resource names                                      |
| 4     | Resource descriptions                               |

- `summary` is added to `EmbedSource.resources`, and the query selects `resource.summary` and
  `resource.summaryMeta`
- **A hidden abstract is not included.** Dropped in TypeScript after the row is read (no WHERE
  needed)
- **Truncation is by sentence.** Today's `slice(0, MAX_EMBED_TEXT_LENGTH)` cuts mid-sentence.
  Abstracts end on a full stop (18 of 18 measured), so the trailing sentence is dropped whole

### 9.2 The chain of dependencies

```
the resource's content changes → the abstract is regenerated → the embedding text changes → re-embed
```

On the incremental side, Summarize calls `enqueueEmbeds` (through the debounce) when it writes an
abstract. On the backfill side, the chain in §11 enqueues once at its terminus.

**Enabling the feature changes every package's embedding hash.** Nothing changes on a site where
it is off.

### 9.3 It goes into the keyword index too (ADR-053 decision 8.1)

The abstract goes into **the resource document as well as the vector**. Decision 3.2 has the
model gloss official terms with the everyday word in parentheses, and that vocabulary is exactly
what a term-matching index can use — a person's description rarely spells both, so without the
abstract it does not exist.

| Change                 | What                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `ResourceDoc`          | add `summary?: string`                                         |
| OpenSearch mapping     | a text field on `kuromoji_analyzer`                            |
| Resource search fields | `['name^3', 'description^2', 'section', 'summary']`            |
| `resourceDocColumns`   | select `publicSummary` — the projection that nulls when hidden |

**Boosted below name and description.** Generated sentences should not outrank a person's.

#### Having nowhere to write it is the point

**Summarize runs after Index.** The document Index wrote describes a resource with no abstract,
and nothing comes back for it — left alone, the abstract **never reaches the index at all**.

Three paths enqueue a `sync-resource-doc` job.

| Path                   | Where                           |
| ---------------------- | ------------------------------- |
| the pipeline step      | beside the embedding enqueue    |
| the backfill walk      | per resource (the vector waits) |
| an editor's own change | `PUT /resources/:id/summary`    |

**Queued rather than written, to settle who retries.** The write that makes the document stale
is not one that can retry it: Summarize runs after Index and is best-effort, so a search index
briefly unreachable is recorded as a failed step, the run completes, and **nothing asks again**.
The editor's path is the same — a retried request changes nothing to re-trigger on.

Queued, the retry belongs to the queue, where every other retry in this pipeline already lives,
and **a search-index blip does not fail a pipeline run** — which rethrowing would have done.

**Enqueued whatever the outcome.** The document is a statement about the row, so restating it is
right even when nothing moved; gated on a write, a sync that failed right after one would find
the abstract unchanged on the retry and never be repaired.

**The last matters most for hiding.** The public projection takes a hidden abstract off the
document, so a document that keeps it is **text somebody took down still answering searches**.

## 10. Step 6: API and web

### 10.1 Public API (`/api/v1` only)

The resource representation gains the abstract. **It is not added to the CKAN-compatible route
(`ckan-compat.ts`).**

```jsonc
"summary": {
  "text": "…",           // null when hidden or not generated
  "source": "ai",
  "version": 3,
  "material": "text-head",
  "generatedAt": "2026-09-13T…",
  "skipReason": null      // why nothing was generated
}
```

Assembled in one place, `publicSummary()` (§4.1).

### 10.2 What an editor can do

`PATCH /api/v1/resource/:id/summary`

- **Override**: replace the text and set `source: 'human'`. The AI never overwrites it again
- **Hide**: `hidden: true`. Display, embedding and generation all stop
- Permissions are the resource's edit permissions

### 10.3 Web

- **The resource detail page (SSR)** shows the abstract under **a heading that names it as AI
  before it is read.**

  On screen it is called a **description**, not an abstract. The precise word is the one the
  ADR, the spec and the types use, and it is a librarian's — a reader of the catalogue is not
  owed it. "Description" also claims nothing about how much of the file was condensed, which
  matters: most are written from a part, and the line below says which part.

  The heading is a badge **above** the text. A footnote underneath is found only by someone who
  already suspected it.

- **How much was read** goes under the text, worded from `material` and `coverage`

  > Read the column layout and the first 5 of 163 rows. This description was generated by AI
  > from v3 of this file (2026-09-13)

  **The version is the resource's, not the prompt's.** Only the former is visible to a reader.

- **Say when the version has moved on.** A number alone only answers "is this current?" for a
  reader who finds the history and compares

  > This file is now at v5. The description has not been updated.

- **The disclaimer goes last**, and does not do the notice's job — what it was made from and
  which version are said above

  > This does not guarantee accuracy or currency. Check the original file for the authoritative
  > record.

- **The reason nothing was generated** is shown, worded per `skipReason`

  > No description was generated for this file because it exceeds the size limit

  **"Cannot" and "will not" are kept apart** — `provider-unavailable` and `disabled` get
  different wording, aligned with the vocabulary in `suggest/availability.ts`

- **Override and hide** in the dashboard's resource editor
- **Where a human description already exists, the AI text is not the lead** (placed under
  `description`)
- **The admin settings** carry the generation language, shown only while a model is configured. Changing it adds "existing abstracts stay in the old language until they are all
  regenerated". The env value reaches the web through the site route's capability (the same shape
  as the `suggest` availability)

## 11. Step 7: the backfill and the admin screen

### 11.1 Job types

```typescript
// packages/shared/src/pipeline-types.ts
export const SUMMARIZE_ALL_JOB_TYPE = 'summarize-all' as const
export const SUMMARIZE_PACKAGE_JOB_TYPE = 'summarize-package' as const
```

| Job                 | Payload                          | What it does                                                                                                               |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `summarize-all`     | `{ refresh }`                    | Fans out one `summarize-package` per `active`, non-private package                                                         |
| `summarize-package` | `{ packageId, after?, refresh }` | Processes the **next one**, advances `after` and requeues itself; when none remain, enqueues `embed-package` once and ends |

**One job, one completion.** A hundred resources in a single job would run for twenty minutes,
be redelivered on the visibility timeout, and **bill every completion twice**.

**`after` is a cursor on `resource.id`, ascending.** Nothing is marked done anywhere, so a
chain that dies is restarted by pressing the button again. A resource whose abstract already
describes its material costs the material read and no completion, which is what makes the chain
safe to start over.

**The embedding is enqueued once, at the end.** The debounce is leading-edge, so fanning out
per resource would settle the package's vector on the first abstract of a hundred.

**A resource somebody else is processing is waited for, not passed over.** The run holding it
writes the abstract only if it reaches the step, and a failed Fetch means it does not. Passing
over drops the resource out of a generation somebody asked for, silently.

- The per-resource claim (ADR-044) is taken exactly as the pipeline takes it
- Packages run in parallel, resources within a package in series — which is also kind to the
  provider's rate limits

### 11.2 The admin screen

A **"Generate AI descriptions"** card sits on `/dashboard/admin/site`, directly below the
model settings that choose the model whose rate the estimate is quoted at. It is kept apart
from the search index actions, because what it rebuilds is what the AI wrote about a dataset,
not an index. "Regenerate embedding vectors", over on index management, **stays a free
action** — folding abstract generation into it would bill every resource to an LLM just
because the embedding model changed.

The card is titled "in bulk". A resource is described automatically by the Summarize step as
it is registered, so this is not the ordinary path — it exists for resources that predate the
setting and for those that need rewriting.

**There are two actions, and they are different amounts of money for different reasons.**

| Action          | Covers                                                       | Job                                |
| --------------- | ------------------------------------------------------------ | ---------------------------------- |
| **Fill in**     | resources with no abstract                                   | `summarize-all { refresh: false }` |
| **Rewrite all** | those, plus ones another model, generation or language wrote | `summarize-all { refresh: true }`  |

**Changing a prompt makes every abstract in the catalogue stale at once, and nobody should find
that out from a bill.** So each estimate is separate and sits **directly above its own button**.

```
GET /api/v1/admin/summary-estimate
→ {
    model, locale,
    fill:    { resources, estimatedInputTokens: { low, high }, estimatedOutputTokens, estimatedCostUsd },
    refresh: { …same shape… },
    skipped: { tooLarge, unsupportedFormat, noMaterial },
  }
```

**Input tokens are a range.** The one input nobody can see from here is a PDF's page count, and
a PDF's tokens follow its pages: extracted text at the bottom, the page limit at the top.

**Cost is shown too** (USD, at the model's recorded rate), output tokens included — on a
catalogue of small files **output is a third of the bill**, so quoting input alone understates
it badly. Rates distinguish `global.*` from `jp.*` (the latter is geo-limited, +10%).

**The estimate's population matches the walk's.** The walk needs an active version holding the
row's hash, so a resource without one is **never visited** — counting it puts money against
work nobody will do. Likewise **the artifacts are asked for on every estimate**: a table with
no schema, a document with no extracted text are not counted. Asking the artifacts rather than
a recorded skip reason matters because a re-interpretation that finally writes a schema creates
no version, so pinning to one would **hide work that will happen** — understating a bill is the
worse direction.

**What is out of scope is counted among the resources with no abstract**, not across the whole
catalogue. It sits under the buttons, so it reads as what they will not cover — counted
catalogue-wide it swept in **files that already have abstracts**, such as oversize PDFs
described from their text layer.

The card is hidden on a site with no model configured. **The model and the generation language
are shown on the card, read-only** — the same shape the embedding card already uses for
`embedModel`. The button's description states that the embeddings are rebuilt when it finishes.

**A button is not live until its estimate is**, and a count of zero keeps it disabled: there is
no sense in being able to press an action that would do nothing.

## 12. New dependencies

| Package   | Added to | Purpose                                 |
| --------- | -------- | --------------------------------------- |
| `pdf-lib` | worker   | PDF page count (pure JS, no rasterizer) |
| `sharp`   | worker   | Image downscaling (prebuilt binaries)   |

## 13. Test strategy

| Kind        | Target                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Unit        | Material routing (characters per PDF page, limits, formats), hash inputs, skip-reason selection          |
| Unit        | Embedding assembly order and **sentence-level truncation**, exclusion of hidden abstracts                |
| Unit        | Adapter: pinned Converse input shape, error classification (permanent vs transient)                      |
| Unit        | The public projection never returns `hash` or `rejectedTokens`                                           |
| Integration | The Summarize step (generate / skip / a failure not affecting later steps), `source: 'human'` protection |
| Integration | The backfill chain (requeue, the terminal embed, resuming mid-way)                                       |
| E2E         | The abstract and its notice on the resource page, the reason when absent, editor override and hide       |

Every LLM call is mocked. The only real provider calls are the evaluation in §14.

## 14. Acceptance criteria (ADR-053)

Measured after implementation; **the numbers are recorded in ADR-053**, which is authoritative.

1. **Zero claims beyond the material** (periods, counts, proper nouns)
2. **Are figure-heavy PDFs being read**
3. **Agreement between the self-report flag and human judgement**
4. **No generation attempted** for over-limit or empty-material resources
5. **It reads as an abstract** (no sentence cut mid-way)
6. **Search quality has not regressed** — the before/after comparison with `pnpm eval:search`

The baseline before abstracts (measured 2026-09-12, overall nDCG from keyword-only to hybrid):

| Environment | Baseline      | Embedding       | How to read it                                         |
| ----------- | ------------- | --------------- | ------------------------------------------------------ |
| Local       | **38% → 82%** | Titan v2        | **Confirming there is no regression**                  |
| demo        | **29% → 87%** | Cohere embed-v4 | **The effect in the production shape** (authoritative) |

**The absolute values are not compared across environments** — the models differ. Only each
environment's own before/after difference is read. Whether the output contains everyday
vocabulary is carried as a measurement of its own.

## 15. Out of scope (follow-ups)

From ADR-053's "what to consider after the MVP", the items this phase does not start.

- **Per-resource vectors** — added right after the MVP. Neither the cut-off (10% of packages) nor
  averaging heterogeneous tables into one vector can be solved at any other granularity
- **Extracted text for Office formats** — decided after the same comparison PDFs got
- **PDF page excerpts**, **pre-estimating Office**, **an Excel grid**
- **Very large PNGs** (switching to a disk-backed path)
- **A dedicated queue and poller** — the trigger is "have uploads become visibly slower"
- **Routing by model** (small for text-heavy, top tier for scans)
- **A two-layer enable/disable** (env as the ceiling, the runtime setting able only to lower it)
- **Multilingual abstracts** (generating both ja and en) — it doubles the cost
- **Generating values** (types, primary keys, header rows, sheet structure) — the scope of
  spec §14.1-4
