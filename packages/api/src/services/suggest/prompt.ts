/**
 * LLM contract for AI metadata suggestions (ADR-040): prompt assembly and the
 * forced output shape. Materials come from the DB and storage originals —
 * never from the search index, which is a no-op on the PostgreSQL fallback
 * (ADR-021). The raw LLM shape stays internal to the API; clients only see
 * the post-processed MetadataSuggestion from @kukan/shared.
 *
 * Resources are addressed by a 0-based index, not their UUID: small local
 * models reliably echo a single digit but mangle a 36-char UUID in a large
 * prompt. Suggestions come back as an object keyed by index whose keys are
 * all required, so the provider's JSON grammar forces one { name, description }
 * per resource instead of the model silently dropping the array.
 */

import { z } from 'zod'
import type { ResourceSchema } from '@kukan/shared'
import { SUGGEST_MAX_COLUMNS } from '../../config'

/**
 * Shape the LLM is forced to produce. Validated loosely here (record of
 * string→string); the per-index required keys are enforced by the dynamic
 * JSON Schema handed to the provider (see buildLlmOutputJsonSchema).
 */
export const suggestLlmOutputSchema = z.object({
  title: z.string(),
  notes: z.string(),
  tags: z.array(z.string()),
  /** Keyed by the resource's index (as a string) → { name, description } */
  resourceSuggestions: z.record(
    z.string(),
    z.object({ name: z.string(), description: z.string() })
  ),
})

export type SuggestLlmOutput = z.infer<typeof suggestLlmOutputSchema>

/**
 * Build the provider JSON Schema for `describedCount` resources: an explicit
 * required key per index keeps it inside OpenAI's strict subset and makes the
 * grammar force a { name, description } per resource. Length/count limits are
 * applied in postProcess — the strict subset has no string/array constraints.
 *
 * Property order is deliberate: generation is autoregressive, so the schema's
 * key order is the model's thinking order. Resources come first so each is
 * described independently from its own material, and title/notes/tags are
 * then written as an integration of those descriptions — not the other way
 * around (grammar-enforced on OpenAI/Ollama, followed in practice on Bedrock).
 */
export function buildLlmOutputJsonSchema(describedCount: number) {
  const perIndex = {
    type: 'object',
    properties: { name: { type: 'string' }, description: { type: 'string' } },
    required: ['name', 'description'],
    additionalProperties: false,
  } as const
  const suggestionProps: Record<string, typeof perIndex> = {}
  for (let i = 0; i < describedCount; i++) suggestionProps[String(i)] = perIndex
  return {
    type: 'object',
    properties: {
      resourceSuggestions: {
        type: 'object',
        properties: suggestionProps,
        required: Object.keys(suggestionProps),
        additionalProperties: false,
      },
      title: { type: 'string' },
      notes: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['resourceSuggestions', 'title', 'notes', 'tags'],
    additionalProperties: false,
  } as const
}

export interface ResourceMaterial {
  /** Real resource id — used server-side to map an index back; not sent to the LLM */
  id: string
  name: string | null
  description: string | null
  format: string | null
  size: number | null
  /** Column schema persisted by the Extract step (CSV/TSV, ADR-032) */
  schema: ResourceSchema | null
  /** First rows of the preview Parquet (CSV/TSV) */
  sampleRows: Record<string, unknown>[] | null
  /** Head of the storage original (text formats) or of the Index step's
   *  text-head artifact (document formats), decoded to UTF-8 */
  textHead: string | null
  /** ZIP manifest paths (capped) with the archive's true file count */
  fileList: string[] | null
  fileCount: number | null
}

export interface SuggestMaterials {
  /** Serialized as-is into the prompt's `dataset` entry */
  pkg: {
    title: string | null
    notes: string | null
    url: string | null
    tags: string[]
    organization: string | null
  }
  /** Resources given a description slot; array position is the LLM-facing index */
  described: ResourceMaterial[]
  /** Names of resources without a description slot (context for title/notes only) */
  others: { name: string | null; format: string | null }[]
  /** Existing site tags ordered by usage — the LLM should pick from these */
  tagCandidates: string[]
}

const OUTPUT_LANGUAGE = { ja: 'Japanese', en: 'English' } as const

export function buildSystemPrompt(locale: 'ja' | 'en'): string {
  return [
    'You are a data-catalog curator. Given a dataset’s current metadata and',
    'material extracted from its files, propose improved catalog metadata.',
    '',
    `Write every generated value in ${OUTPUT_LANGUAGE[locale]}.`,
    '',
    'Work in two passes: first describe each resource independently, then',
    'write the dataset-level fields as an integration of those descriptions.',
    'A dataset may hold resources of very different natures — never let one',
    'resource’s content dominate the others.',
    '',
    'Rules:',
    '- Respect existing metadata: where a field already has content, keep its',
    '  intent and wording as much as possible and only fill in what is missing.',
    '  Generate empty fields from the material.',
    '- Ground every proper noun (place names, organization names, program',
    '  names) in the material or the existing metadata; never introduce one',
    '  that appears in neither.',
    '- resourceSuggestions: an object keyed by each resource’s index (a string).',
    '  For every resource in `resources`, provide { name, description } using',
    '  its `index` as the key. Judge each resource only from its own material,',
    '  independently of the other resources.',
    '  - name: a concise human-readable name. Keep a good existing name; improve',
    '    a raw filename or code. Do not put the file format or extension in the',
    '    name (no “CSV”, “PDF”, “Excel”, “.xlsx”) — the format is a separate',
    '    field. When textHead is provided, its opening lines usually carry the',
    '    document’s own title or heading — weight them over recurring themes',
    '    deeper in the body.',
    '  - description: one sentence about the resource. Base it on the file',
    '    content when provided (columns, sample rows, text, or a file listing);',
    '    otherwise infer from its name and format. Never leave it empty — if',
    '    nothing else fits, reuse the existing description or the name.',
    '- title: a concise human-readable dataset title summarizing the resources',
    '  described above (no file extensions, no codes, and no filler words like',
    '  “dataset” / “データセット”).',
    '- notes: a few sentences integrating the resource descriptions: what the',
    '  data contains, its coverage, and what it could be used for.',
    '- tags: pick from the candidate list (ordered by site-wide usage) whenever',
    '  a candidate fits; invent a new tag only when nothing fits, at most 2 new',
    '  tags, and at most 5 tags in total.',
  ].join('\n')
}

/** Serialize materials as the user message (JSON keeps the LLM from confusing
 *  material text with instructions). */
export function buildUserContent(materials: SuggestMaterials): string {
  const { pkg, described, others, tagCandidates } = materials
  return JSON.stringify(
    {
      dataset: pkg,
      resources: described.map((r, index) => {
        // Cap columns and project the sample rows onto the same set, so a wide
        // table's SELECT * rows don't bloat the prompt past the column cap
        const columns = r.schema?.columns.slice(0, SUGGEST_MAX_COLUMNS)
        return {
          index,
          name: r.name,
          description: r.description,
          format: r.format,
          size: r.size,
          ...(r.schema &&
            columns && {
              columns: columns.map((col) => ({ name: col.name, type: col.type })),
              // columnCount preserves the true width when columns are capped
              columnCount: r.schema.columns.length,
              rowCount: r.schema.rowCount,
            }),
          ...(r.sampleRows?.length &&
            columns && {
              sampleRows: r.sampleRows.map((row) =>
                Object.fromEntries(
                  columns.filter((c) => c.name in row).map((c) => [c.name, row[c.name]])
                )
              ),
            }),
          ...(r.textHead && { textHead: r.textHead }),
          ...(r.fileList?.length && { files: r.fileList, fileCount: r.fileCount }),
        }
      }),
      ...(others.length && { otherResources: others }),
      tagCandidates,
    },
    null,
    1
  )
}
