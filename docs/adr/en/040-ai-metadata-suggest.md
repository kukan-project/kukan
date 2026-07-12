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

### 3. Generation material — no dependency on the search index

| Material                                  | Source                              | Formats    |
| ----------------------------------------- | ----------------------------------- | ---------- |
| Existing metadata (title, notes, tags, …) | DB                                  | all        |
| Resource names, format, size              | DB                                  | all        |
| Column schema (ADR-032)                   | `resource_pipeline.metadata.schema` | CSV / TSV  |
| Sample rows (first few)                   | Parquet preview (storage)           | CSV / TSV  |
| First N KB of text                        | Storage original (`downloadRange`)  | text-based |

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
  are prioritized for the slots
- ZIP manifests are out of scope for v1 (the central directory sits at the
  end of the file and cannot be obtained from a head read)

### 4. Implementing `AIAdapter.complete()`

Four implementations following the same deployment pattern as ADR-034.

| Environment       | Implementation                                  |
| ----------------- | ----------------------------------------------- |
| AWS               | Bedrock Converse API (Claude Haiku class)       |
| On-premises       | Ollama (Japanese-capable model)                 |
| OpenAI-compatible | Chat Completions                                |
| No AI             | NoOp — reports no capability; feature is hidden |

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
- Model selection is finalized by measurement during implementation, and
  **prioritizes multilingual support** (Japanese is the primary target for
  now, but overseas deployments are in scope, so language-specific fine-tuned
  models are not adopted). Default candidates: **Claude Haiku class on
  Bedrock** (multilingual with good cost/latency; JSON output enforced via
  Converse API tool use; the `jp.` cross-region inference profile keeps
  inference within the Tokyo/Osaka regions for domestic data-processing
  requirements; the Amazon Nova Lite class is included in the evaluation as
  the cost alternative) and **Gemma 4 class (E4B and up) on Ollama** (140+
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

## Future Extensions (out of scope for this ADR)

- Separate-lane automatic generation (option B): pipeline generation into
  `aiSummary` / `aiTags` with "AI-generated" labeling. The columns are
  retained for this purpose
- Integration with quality monitoring (ADR-006, `qualityScore`): detect
  datasets with thin descriptions or missing tags and guide users to the AI
  suggestion in the edit form
- Material support for ZIP manifests and Office formats

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
