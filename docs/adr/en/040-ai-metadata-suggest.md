# ADR-040: AI Metadata Suggestions (Suggestion-Based, On-Demand Generation)

## Status

**Accepted**

## Context

Metadata quality determines how discoverable a catalog is, but writing it is
a burden, and datasets with one-line descriptions and no tags are common.
The foundation for AI assistance is already in place:

- `AIAdapter.complete()` is defined as an interface but not yet implemented
- The `package` table has reserved (unused) `aiSummary` / `aiTags` columns
- ADR-032 persists CSV/TSV column schemas in the DB, and ADR-014/029 keep
  Parquet previews in storage
- The draft state introduced by ADR-039 enables a file-first flow — upload
  first, look at the content, then write metadata

Sourcing the input material has an environment-difference trap, however.
Resource text extracted by the pipeline goes into the `kukan-contents` index
on OpenSearch deployments, but **on the PostgreSQL fallback `indexContent()`
is a no-op and the extracted text is stored nowhere**. Using the search index
as generation material would break the feature on on-premises deployments.

## Options Considered

### A) Fully automatic — rewrite official metadata (notes / tags)

- Problems: destroys the provenance of a data catalog (who wrote what);
  mis-generations go public as-is. Rejected

### B) Separate-lane automatic — generate in the pipeline into `aiSummary` / `aiTags`

- Strengths: helps neglected datasets too; matches the intent of the
  reserved columns
- Problems: LLM cost on every resource processed; requires UX design for
  labeling and searching "AI-generated" content
- Verdict: not adopted in v1; **kept as a future extension** (columns
  retained)

### C) Suggestion-based — generate on manual trigger, human reviews and adopts — adopted

- Generation happens only when the user presses the button (predictable cost)
- Suggestions are never persisted; only adopted values are saved through the
  normal update path (human-in-the-loop, zero DB changes)

## Decision

**Add a synchronous, stateless suggestion API called on demand from the edit
form. Generation material does not depend on the search backend — it is
assembled on demand from the DB and storage originals, then discarded.**

### 1. API

- Add `POST /api/v1/packages/{id}/suggest-metadata`
- Synchronous and stateless. Suggestions are not persisted (adoption happens
  via the normal PATCH / PUT)
- Permission is identical to package update permission (drafts follow the
  creator rule of ADR-039)
- Per-user rate limiting caps LLM cost

### 2. Generation targets and response format

> **Note: the "single LLM call generating everything", index references, and
> generation-order grammar enforcement in this section are superseded by
> "Addendum: per-resource parallel generation (2026-07-16)" below.**
> The response format (field set, Zod validation, adoption UI) remains valid.

- `title` / `notes` / `tags` / per-resource `name` and `description` are
  generated in **a single LLM call** (better for both cost and latency)
- The response is JSON validated with Zod (one retry on parse failure)
- The UI adopts per field, so there is no need to split generation
  granularity. Overwriting existing metadata should be deliberate, so **every
  adoption toggle defaults to OFF (opt-in)**. An adopted field can also be
  edited inline before applying (tags use the same comma-separated form as the
  edit form)
- Resources are addressed by a 0-based index rather than their UUID, and the
  response is an object with a required key per index. Small local models
  (4-8B) can mangle a 36-char UUID inside a large prompt and drop the whole
  array, so the grammar forces one suggestion per resource
- Generation order is **resources first, then the dataset** (supplemented
  2026-07-15). Generation is autoregressive, so the output schema's property
  order is the model's thinking order: `resourceSuggestions` comes first,
  prescribing "describe each resource independently from its own material,
  then write title / notes / tags as an integration of those descriptions"
  at the grammar level (grammar-enforced on OpenAI / Ollama, followed in
  practice on Bedrock). This keeps a single resource's content from
  dominating the description of a dataset whose resources differ in nature

### 3. Generation material — no dependency on the search index

| Material                                    | Source                              | Formats      |
| ------------------------------------------- | ----------------------------------- | ------------ |
| Existing metadata (title, notes, tags, …)   | DB                                  | all          |
| Resource names, format, size                | DB                                  | all          |
| Column schema (ADR-032)                     | `resource_pipeline.metadata.schema` | CSV / TSV    |
| Sample rows (first few)                     | Parquet preview (storage)           | CSV / TSV    |
| First N KB of text                          | Storage original (`downloadRange`)  | text-based   |
| Extracted text head (2026-07-15 addendum)   | Index step artifact (storage)       | PDF / Office |
| Manifest path listing (2026-07-15 addendum) | Manifest JSON (storage)             | ZIP          |

- Only the first N KB of text is extracted on demand, and it is **discarded
  after generation** (nothing new is persisted, no invalidation; always
  matches the current file; no OpenSearch / PostgreSQL environment
  difference)
- The column schema and Parquet sample rows are **read from the Extract
  step's existing persisted artifacts** — nothing is generated or deleted
  for the suggestion (the preview feature's artifacts are borrowed; CSV/TSV
  sample rows therefore require Extract to have completed)
- Move `detectEncoding` from the worker to shared for reuse. Multi-byte
  characters truncated at the end of a range read are dropped (same handling
  as the existing trailing removal of the UTF-8 replacement character
  U+FFFD)
- Every resource gets a name + description slot regardless of format, so
  non-tabular files (PDF, Excel, images) also get a suggested name, and the
  description is inferred from the filename/format when no content is
  available. Content (column schema, sample rows, head text) is attached only
  to content-eligible resources (pipeline complete + CSV/TSV or text), which
  are prioritized for the slots (PDF / Office and ZIP were added as content
  formats in the 2026-07-15 addendum)
- ZIP manifests are out of scope for v1 (the central directory sits at the
  end of the file and cannot be obtained from a head read) — covered by the
  2026-07-15 addendum

### 4. Implementing `AIAdapter.complete()`

Four implementations following the same deployment pattern as ADR-034.

| Environment       | Implementation                                        |
| ----------------- | ----------------------------------------------------- |
| AWS               | Bedrock Converse API (default Amazon Nova Lite class) |
| On-premises       | Ollama (Japanese-capable model)                       |
| OpenAI-compatible | Chat Completions                                      |
| No AI             | NoOp — reports no capability; feature is hidden       |

- Add the suggestion capability to `GET /api/v1/site` so the frontend hides
  the button entirely (same pattern as exposing vector-search support)
- The generation model is a **separate model** from the embedding model
  (bge-m3 / Titan / Cohere are embedding-only and cannot generate). Its
  configuration has two layers: the **provider** (Bedrock / Ollama / OpenAI /
  NoOp) stays an environment variable because it is tied to credentials and
  infrastructure, while the **model ID** is a runtime system setting
  (ADR-036) switchable from the admin screen (sysadmin) without a redeploy
  (falling back to a per-provider default). Unlike the embedding model —
  which cannot change at runtime because stored vectors must stay consistent
  — the generation model persists nothing, so switching is safe. The admin
  screen includes a connection test (a small trial prompt) so a
  not-yet-enabled or not-yet-pulled model ID is detected immediately
- The **candidates** for the runtime setting come from the environment
  variable `AI_COMPLETION_MODELS` (comma-separated, first entry = default),
  unified across all providers (supplemented 2026-07-14). It is the
  **allow-list of models the deployment has approved for use** and becomes
  the admin picker options as-is. Models available on the server (pulled on
  Ollama, served by an OpenAI-compatible endpoint) are not offered unless
  listed — "available" and "approved" are separate judgements, so no server
  enumeration is performed. Invocation outside the list is stopped by IAM on
  Bedrock (CDK grants exactly the list) and by allow-list validation at
  resolution time on the other providers. With Docker Compose, ollama-init
  pulls the same list, so approved = runnable holds from startup
- Model selection is finalized by measurement during implementation, and
  **prioritizes multilingual support** (Japanese is the primary target for
  now, but overseas deployments are in scope, so language-specific fine-tuned
  models are not adopted). Default: **Amazon Nova Lite class on
  Bedrock** (its measured quality met the bar, so the lower-cost Nova — with a
  good multilingual/cost/latency balance — is the default; JSON output enforced
  via Converse API tool use; the `jp.` cross-region inference profile keeps
  inference within the Tokyo/Osaka regions for domestic data-processing
  requirements; the Claude Haiku class and above can be added to
  completionModels to opt into higher quality) and **Gemma 4 class (E4B and up) on Ollama** (140+
  languages, Apache 2.0, CPU-efficient effective-parameter design; JSON
  enforced via structured outputs). Qwen3 instruct remains the alternative
  where Japanese quality matters most. Evaluate like ADR-034 with a small
  golden set (a few datasets with known-good metadata), checking generation
  quality and JSON compliance
- Additionally, **measure quality by sampling existing data**. The primary
  purpose is quality assessment: **among models that meet the quality bar,
  adopt the cheapest one** (e.g. prefer the Nova Lite class over Haiku if its
  quality is sufficient). Stratify the sample so format mix (CSV-heavy,
  text-based, resource-less) and size are not skewed. As a secondary output,
  measure per-suggestion cost and latency from the distribution of
  input/output token counts on real material (usage frequency cannot be
  predicted up front, so estimates come from measurement, not price sheets)
- For CPU-only deployments (e.g. closed networks) an effective-4B-class model
  (such as Gemma 4 E4B) is recommended. CPU inference can take tens of
  seconds to minutes per suggestion, so the suggest endpoint's timeout —
  including the reverse proxy (Caddy etc.) — must be set generously (verify
  during implementation)
- Note, however, that small local models (effective 4–8B class) are
  **genuinely underpowered at the suggestion quality itself**. This is
  separate from JSON compliance (guaranteed by the index-reference grammar
  forcing in §2): the content quality tends to degrade — descriptions miss
  the point, tags are off-target, and Japanese output is unstable in
  multilingual models. Closed-network / CPU-only deployments should therefore
  operate on the premise that "a suggestion is only a draft" and treat human
  review (human-in-the-loop, option C) as a mandatory step. Where generation
  quality matters, choose Bedrock (Nova Lite and up, or Claude Haiku class if
  needed) or a larger Ollama model given sufficient VRAM (larger Gemma 4
  sizes, Qwen3-class instruct). This is a scale limitation and improves by
  switching to a larger model (the generation model is a runtime setting,
  changeable without redeploy, and switching is safe because suggestions are
  never persisted)

### 5. Tag governance

Naive generation floods the catalog with free tags (and burdens the orphan
tag GC), so the prompt constrains it.

- Pass the site's existing tags (top N by usage) as candidates and instruct:
  "choose from these in principle; only when nothing fits, propose at most 2
  new tags"
- Cap suggested tags at roughly 5 in total
- The candidate scope (site-wide vs. per-organization) is evaluated during
  implementation

### 6. Entry points and UI

- **Entry ① — draft wizard (ADR-039)**: generate into the empty form after
  resource processing completes. The core of the file-first flow
- **Entry ② — edit form of published datasets**: include current values in
  the prompt and generate an improvement pass — "fill blanks, respect
  existing text, supplement what is missing"
- The UI is a shared component showing current values and suggestions side
  by side with per-field adoption (for new datasets the current-value column
  is simply empty)
- The button is disabled while no resource has been processed. Generation is
  manual-trigger only, but **the UI guides users toward it**: while there are
  no (processed) resources, the disabled button explains that uploading
  resources enables AI metadata suggestions, and when pipeline processing
  completes, a nudge asks "let AI suggest metadata?" (neither issues an LLM
  call until clicked)
- Generation language follows the site locale (no automatic source-language
  detection)

## Consequences

- The burden of writing metadata drops; descriptions and tags become richer
- Because suggestions are not persisted, no DB migration, queue, or worker
  changes are needed (apart from moving `detectEncoding` to shared, the
  server side stays within the API package)
- In NoOp (no-AI) environments the feature simply does not appear; nothing
  else is affected
- LLM calls are manual-trigger only, so cost is bounded by rate limiting

## Addendum: content material support for PDF / Office / ZIP (2026-07-15)

The future extension "material support for ZIP manifests and Office
formats" is promoted to the implementation, with PDF added.

Underlying fact: the worker's Index step (ADR-021) already runs officeparser
text extraction on every pipeline run regardless of the search engine, and
on the PostgreSQL fallback the result is discarded because `indexContent()`
is a no-op. Extraction therefore already happens in every environment, and
persisting it costs practically nothing. The "borrow the pipeline's
persisted artifacts" pattern (§3, as with Parquet previews) is extended to
document formats and ZIP.

1. **worker (Index step)**: for document formats (those supported by
   officeparser — PDF / DOCX / XLSX / PPTX / ODT / ODP / ODS / RTF; legacy
   DOC / XLS / PPT remain unsupported), save the first 64 KB of the
   extracted text to storage as `previews/{packageId}/{resourceId}.txt`
   (UTF-8), and record the key and size in `resource_pipeline.metadata`
   (`textHeadKey` / `textHeadBytes`). The suggest side trusts only the DB
   record when reading, avoiding existence-check round trips and stale
   artifact reads
2. **State gate restructuring**: the Index step used to be skipped entirely
   unless the package was active (drafts stay out of the content index —
   ADR-039). This changes so that extraction + artifact persistence run for
   drafts too, and only the search engine indexing is gated on active. The
   AI suggestion's primary arena is draft editing (entry ①), and having no
   PDF/Office material until publish would defeat the purpose. Deleted /
   purging packages still skip the whole step as before
3. **api (material collection)**: for document formats, read the first
   N KB of this artifact, in the same shape as the text formats'
   `downloadRange`. For ZIP, read the path listing from the Extract step's
   existing manifest JSON (`previewKey`), clamped by bytes and entry count
   (no worker change for ZIP)

Notes:

- Persisting 64 KB while reading N KB (currently 16 KB) lets a future
  increase of the suggest-side prompt budget take effect without
  reprocessing already-stored resources
- No encoding detection is needed: officeparser pulls characters out of the
  format's internal structure (the XML inside DOCX/XLSX is UTF-8 by spec;
  PDF font encoding maps are resolved by the parser), so the extraction
  result is always a JS string. The artifact is written as UTF-8, and unlike
  the text formats, the suggest side **decodes it as fixed UTF-8** without
  consulting `metadata.encoding` / `detectEncoding` (same treatment as
  JSON/GeoJSON). The 64 KB truncation drops multi-byte characters cut at
  the boundary, as `truncateToByteLimit` already does
- Materials still come from storage artifacts + the DB, preserving the
  no-search-backend principle (§3) and OpenSearch / PostgreSQL parity. No
  extra download or parsing happens at suggest time
- The text body is not stored directly in `resource_pipeline.metadata`:
  several API paths SELECT the whole metadata column (e.g. for the
  encoding), so tens of KB per resource would bloat unrelated queries
- Cleanup: stale metadata keys need no explicit handling — the Extract step
  replaces the metadata wholesale on every success, so a run after a format
  change naturally drops `textHeadKey` (on a transient Extract failure the
  previous values remain, following the existing keep-the-previous-preview
  design, and the next successful run resolves it). Stale storage artifacts
  are handled like Parquet previews (same-key overwrite; removed by
  `deleteByPrefix` on package purge)

## Addendum: per-resource parallel generation (2026-07-16)

Replace §2's "single LLM call generating everything" with a **two-phase
scheme: one completion per resource run in parallel, plus one integration
call**. The API surface (endpoint, response shape, non-persistence of
suggestions) does not change.

Limits of the single-call approach revealed by implementation and operation:

1. **Structural breakdown on small local models**: effective 4–8B-class models
   corrupt UUIDs inside large prompts and drop entire arrays, which forced the
   index-reference + grammar-enforcement workaround (§2). Because the response
   is one long JSON document, hitting `maxTokens` or any format drift destroys
   the entire response
2. **The resource cap is bound by output tokens**: every described resource
   must carry name + description in the response JSON, so output grows
   linearly with count; `SUGGEST_MAX_RESOURCES = 10` is effectively derived
   backwards from `SUGGEST_MAX_TOKENS = 4,000`, the guard against mid-object
   JSON truncation
3. **Material dilution**: the 64KB prompt budget is shared across all
   resources, so more resources means less material per resource
4. **Collision with the practical envelope of small models**: the current
   envelope sits right at the practical ceiling of effective 4–8B models
   (roughly 10 independently-judged items, 1–2K tokens of structured JSON in
   one pass); the measured hallucinations (which triggered the guardrails
   above) occurred at this scale

Alternatives were rejected: proportionally raising the constants (20 resources
/ 8,000 tokens) doubles generation time and cost and further degrades small
models; chunking into batches of 10 keeps the single-call weaknesses within
each chunk and only treats the symptom.

### Call structure

```
Phase 1 (parallel × N):
  input:  only that resource's material (name / format / size / schema / sampleRows / textHead / fileList) + shared instructions
  output: { name, description }   … ~100 tokens of real output

Phase 2 (once):
  input:  existing dataset metadata + the Phase 1 name / description list + tag candidates + group candidates
  output: { title, notes, tags, groups, name }   … groups / name per "Additional generation targets" below
```

- "Judge each resource independently → describe the dataset as their
  integration" (the 2026-07-15 generation-order addendum) is **physically
  enforced by the call boundary**, with no need to rely on schema property
  order. Index references also become unnecessary (each call's context
  contains exactly one resource; the mapping is held on the application side)
- Each call's response JSON is a trivial 2–3-key structure, so grammar
  enforcement works reliably even on small models

### Concurrency (per provider)

| Provider          | Concurrency guide | Rationale                                                                                                                         |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bedrock           | 4–8               | Serverless — no instance to saturate — but per-model RPM / TPM quotas apply. Retry `ThrottlingException` with exponential backoff |
| OpenAI-compatible | 4–8               | Same backoff for 429 rate limits                                                                                                  |
| Ollama            | 1–2               | CPU inference shares cores; concurrency does not raise total throughput. Also matches the `OLLAMA_NUM_PARALLEL` default           |

Concrete values become constants at implementation time; promote to ADR-036
runtime settings only if operational tuning becomes necessary. On CPU-only
environments this is effectively sequential and total time matches the
single-call approach — the goal is not speed but **shrinking each call's
envelope for reliability and scalability**.

### Partial failure — graceful degradation

- Each resource call gets one retry on invalid JSON (as before). Resources
  that still fail are excluded from the suggestion and Phase 2 proceeds with
  the successes (in the proposal-style UI a missing resource simply shows its
  current values — a natural degradation). Failures are logged at warn level
  (to observe per-model failure rates)
- If all resources fail, or Phase 2 fails, return `ServiceUnavailableError`
  as before

### Redefining budgets and caps

- **Output**: tighten `maxTokens` per call (guide: Phase 1 = 500, Phase 2 =
  2,000; keep at least the current safety margin against mid-object JSON
  truncation)
- **Input**: Phase 1 carries one resource's material only, so the existing
  per-resource clamps suffice. The 64KB prompt budget and trim ladder shrink
  to Phase 2 use or are removed
- **`SUGGEST_MAX_RESOURCES` changes meaning**: from a model constraint
  (derived from output tokens) to a cost / latency / review-UX cap. Keep 10
  initially; raising it no longer requires re-engineering the envelope
- **Timeouts**: replace the single 120-second all-or-nothing window with
  short per-call timeouts (guide: 60 seconds). Estimate the whole request as
  "per-call timeout × ⌈count ÷ concurrency⌉ + Phase 2"; verify the CPU-only
  upper bound together with reverse-proxy settings at implementation time

### Quality evaluation and known trade-offs

- Using the §4 golden-set method, **compare single-call (previous) vs split
  (this addendum) on the same datasets** before switching (Gemma 3n E4B /
  Nova Lite; axes: JSON conformance rate, hallucination, content quality,
  stylistic consistency)
- **Stylistic inconsistency** from independent generation is the anticipated
  drawback; contain it with shared instructions. Only if evaluation shows it
  unacceptable, consider light normalization in Phase 2 (by default, resource
  descriptions are returned as generated — the integration call must not
  rewrite them)
- The input-token overhead of repeating the instructions N + 1 times is minor
  (input pricing is low; cost is dominated by output tokens, roughly the same
  as before)
- Progressive delivery (streaming per-resource suggestions to the UI as they
  land) remains a future extension out of scope; the call split lays its
  groundwork

### Additional generation targets — category and URL identifier (dataset side)

Add `groups` (categories) and `name` (URL identifier) to Phase 2's generation
targets. The new response fields are backward-compatible (additive), but the
adoption UI needs new rows for category and URL identifier.

- **groups**: the same closed-list scheme as tag control (§5). Pass all site
  groups (name + title — the same list as the form's category selector) as
  candidates and instruct: "only clearly applicable ones, at most 3; never
  invent a group absent from the candidates". The response is an array of
  group names; values not in the candidate list are discarded server-side.
  Group selection merely prefills an existing form field editors can already
  set freely, so no new permission surface arises (and unlike tags there is
  no new-item creation, making control simpler)
- **name**: have the LLM generate an ASCII slug (`^[a-z0-9._-]+$`, 2–100
  chars) from the suggested title. Romanizing / English-slugifying a Japanese
  title is something LLMs do better than mechanical transliteration
  libraries. The server normalizes (lowercase, strip invalid characters,
  collapse hyphens), validates, checks uniqueness in the DB, and appends a
  numeric suffix on conflict. If the normalized value still fails validation,
  the field is omitted entirely (graceful degradation)
- **`name` is suggested for drafts only**: changing a published dataset's URL
  identifier breaks external links and citations, so entry point ② (editing a
  published dataset) excludes `name` from generation targets. A draft's name
  is an auto-generated placeholder (ADR-039), which is also where the
  suggestion is most valuable

## Future Extensions (out of scope for this ADR)

- Separate-lane automatic generation (option B): pipeline generation into
  `aiSummary` / `aiTags` with "AI-generated" labeling. The columns are
  retained for this purpose
- Integration with quality monitoring (ADR-006, `qualityScore`): detect
  datasets with thin descriptions or missing tags and guide users to the AI
  suggestion in the edit form

## Related

- ADR-021: Resource content full-text search (why the search backend is not
  used as material — the PG fallback is a no-op)
- ADR-029: CSV/TSV preview Parquet column type inference (source of sample
  rows)
- ADR-032: MCP data query foundation (persisted column schemas)
- ADR-034: Metadata vector search (precedent for the AI adapter deployment
  pattern)
- ADR-036: Runtime system settings backed by the DB (foundation for the
  generation model ID setting)
- ADR-039: Package draft state (the file-first flow behind entry ①)
