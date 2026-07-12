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
      title: { type: 'string' },
      notes: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      resourceSuggestions: {
        type: 'object',
        properties: suggestionProps,
        required: Object.keys(suggestionProps),
        additionalProperties: false,
      },
    },
    required: ['title', 'notes', 'tags', 'resourceSuggestions'],
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
  /** Head of the storage original, decoded to UTF-8 (text formats) */
  textHead: string | null
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
    'Rules:',
    '- Respect existing metadata: where a field already has content, keep its',
    '  intent and wording as much as possible and only fill in what is missing.',
    '  Generate empty fields from the material.',
    '- title: a concise human-readable dataset title (no file extensions,',
    '  no codes, and no filler words like “dataset” / “データセット”).',
    '- notes: a few sentences describing what the data contains, its coverage,',
    '  and what it could be used for.',
    '- tags: pick from the candidate list (ordered by site-wide usage) whenever',
    '  a candidate fits; invent a new tag only when nothing fits, at most 2 new',
    '  tags, and at most 5 tags in total.',
    '- resourceSuggestions: an object keyed by each resource’s index (a string).',
    '  For every resource in `resources`, provide { name, description } using',
    '  its `index` as the key.',
    '  - name: a concise human-readable name. Keep a good existing name; improve',
    '    a raw filename or code. Do not put the file format or extension in the',
    '    name (no “CSV”, “PDF”, “Excel”, “.xlsx”) — the format is a separate',
    '    field.',
    '  - description: one sentence about the resource. Base it on the file',
    '    content when provided (columns, sample rows, or text); otherwise infer',
    '    from its name and format. Never leave it empty — if nothing else fits,',
    '    reuse the existing description or the name.',
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
        }
      }),
      ...(others.length && { otherResources: others }),
      tagCandidates,
    },
    null,
    1
  )
}
