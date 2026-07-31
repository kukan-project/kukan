/**
 * LLM contract for AI metadata suggestions (ADR-040): prompt assembly and the
 * forced output shapes. Materials come from the DB and storage originals —
 * never from the search index, which is a no-op on the PostgreSQL fallback
 * (ADR-021). The raw LLM shapes stay internal to the API; clients only see
 * the post-processed MetadataSuggestion from @kukan/shared.
 *
 * Generation is split into two phases (ADR-040 parallel-generation addendum):
 * one completion per resource whose context holds only that resource's
 * material, then one dataset completion that integrates the generated
 * descriptions. Each response is a trivial few-key JSON object, so the
 * provider's grammar enforcement stays reliable even on small local models —
 * no index keys, no long single-pass JSON.
 */

import { z } from 'zod'
import type { ResourceSchema } from '@kukan/shared'
import { SUGGEST_MAX_COLUMNS } from '../../config'

// --- Phase 1: one resource per completion ---

export const resourceLlmOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
})

export type ResourceLlmOutput = z.infer<typeof resourceLlmOutputSchema>

export const RESOURCE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: 'string' } },
  required: ['name', 'description'],
  additionalProperties: false,
} as const

export interface ResourceMaterial {
  /** Real resource id — used server-side to map results back; not sent to the LLM */
  id: string
  name: string | null
  description: string | null
  format: string | null
  size: number | null
  /** Column schema persisted by the Interpret step (CSV/TSV, ADR-032) */
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

const OUTPUT_LANGUAGE = { ja: 'Japanese', en: 'English' } as const

/** Rules shared verbatim by both phases — keep the two prompts in sync */
const GROUNDING_RULES = [
  '- Respect existing metadata: where a field already has content, keep its',
  '  intent and wording as much as possible and only fill in what is missing.',
  '  Generate empty fields from the material.',
  '- Ground every proper noun (place names, organization names, program',
  '  names) in the material or the existing metadata; never introduce one',
  '  that appears in neither.',
]

export function buildResourceSystemPrompt(locale: 'ja' | 'en'): string {
  return [
    'You are a data-catalog curator. Given one resource (file) of a dataset —',
    'its current metadata and material extracted from the file — propose an',
    'improved name and description for that resource.',
    '',
    `Write every generated value in ${OUTPUT_LANGUAGE[locale]}.`,
    '',
    'Rules:',
    ...GROUNDING_RULES,
    '- name: a concise human-readable name. Keep a good existing name; improve',
    '  a raw filename or code. Do not put the file format or extension in the',
    '  name (no “CSV”, “PDF”, “Excel”, “.xlsx”) — the format is a separate',
    '  field. When textHead is provided, its opening lines usually carry the',
    '  document’s own title or heading — weight them over recurring themes',
    '  deeper in the body.',
    '- description: one to three sentences, at most about 300 characters.',
    '  Let the material set the length — write more only when the content',
    '  genuinely supports it; when little is known, one short sentence is',
    '  right. Never pad with repetition or generic filler. Base it on the',
    '  file content when provided (columns, sample rows, text, or a file',
    '  listing); otherwise infer from its name and format. Never leave it',
    '  empty — if nothing else fits, reuse the existing description or the',
    '  name.',
  ].join('\n')
}

/** Serialize one resource's material as the user message (JSON keeps the LLM
 *  from confusing material text with instructions). */
export function buildResourceUserContent(material: ResourceMaterial): string {
  return JSON.stringify({ resource: serializeResource(material) }, null, 1)
}

function serializeResource(r: ResourceMaterial) {
  // Cap columns and project the sample rows onto the same set, so a wide
  // table's SELECT * rows don't bloat the prompt past the column cap
  const columns = r.schema?.columns.slice(0, SUGGEST_MAX_COLUMNS)
  return {
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
          Object.fromEntries(columns.filter((c) => c.name in row).map((c) => [c.name, row[c.name]]))
        ),
      }),
    ...(r.textHead && { textHead: r.textHead }),
    ...(r.fileList?.length && { files: r.fileList, fileCount: r.fileCount }),
  }
}

// --- Phase 2: dataset integration ---

export const datasetLlmOutputSchema = z.object({
  title: z.string(),
  notes: z.string(),
  tags: z.array(z.string()),
  /** Names of existing groups (closed candidate list) */
  groups: z.array(z.string()),
  /** URL slug — requested for drafts only */
  name: z.string().optional(),
})

export type DatasetLlmOutput = z.infer<typeof datasetLlmOutputSchema>

/**
 * Provider JSON Schema for the integration call. Property order is deliberate:
 * generation is autoregressive, so title comes first and the slug (`name`,
 * drafts only) last, derived from the already-written title. The strict
 * subset has no string/array constraints — limits live in postProcess.
 */
export function buildDatasetOutputJsonSchema(suggestName: boolean) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      notes: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      groups: { type: 'array', items: { type: 'string' } },
      ...(suggestName && { name: { type: 'string' } }),
    },
    required: ['title', 'notes', 'tags', 'groups', ...(suggestName ? ['name'] : [])],
    additionalProperties: false,
  } as const
}

export interface DatasetMaterials {
  /** Serialized as-is into the prompt's `dataset` entry */
  pkg: {
    title: string | null
    notes: string | null
    url: string | null
    tags: string[]
    /** Current category memberships (group names) — always kept; suggestions
     *  are additions only */
    groups: string[]
    organization: string | null
  }
  /** Phase 1 results: the generated name/description per resource, in
   *  package order (format kept as light context) */
  resources: { name: string; description: string; format: string | null }[]
  /** Resources without a Phase 1 result (beyond the cap or failed) — context
   *  for title/notes only */
  others: { name: string | null; format: string | null }[]
  /** Existing site tags ordered by usage — the LLM should pick from these */
  tagCandidates: string[]
  /** Existing groups (closed list) — the LLM must pick from these */
  groupCandidates: { name: string; title: string | null; description?: string }[]
}

export interface DatasetPromptOptions {
  /** Include the URL-slug field (drafts only) */
  suggestName: boolean
  /** The dataset has no category yet and candidates exist — require one */
  requireGroup: boolean
}

export function buildDatasetSystemPrompt(
  locale: 'ja' | 'en',
  { suggestName, requireGroup }: DatasetPromptOptions
): string {
  return [
    'You are a data-catalog curator. Given a dataset’s current metadata and a',
    'description of each of its resources (files), propose improved',
    'dataset-level catalog metadata that integrates those descriptions.',
    '',
    `Write every generated value in ${OUTPUT_LANGUAGE[locale]}.`,
    '',
    'A dataset may hold resources of very different natures — never let one',
    'resource’s description dominate the others.',
    '',
    'Rules:',
    ...GROUNDING_RULES,
    '- title: a concise human-readable dataset title summarizing the resource',
    '  descriptions (no file extensions, no codes, and no filler words like',
    '  “dataset” / “データセット”).',
    '- notes: a few sentences integrating the resource descriptions: what the',
    '  data contains, its coverage, and what it could be used for.',
    '- tags: pick from tagCandidates (ordered by site-wide usage) whenever a',
    '  candidate fits; invent a new tag only when nothing fits, at most 2 new',
    '  tags, and at most 5 tags in total. The dataset’s current tags are',
    '  always kept — suggest additions only.',
    ...(requireGroup
      ? [
          '- groups: dataset categories. The dataset has none yet — pick the',
          '  single best-matching entry from groupCandidates (each carries a',
          '  name, title, and description) and return its `name`; add up to 2',
          '  more only when they clearly apply. Never invent a group that is',
          '  not among the candidates.',
        ]
      : [
          '- groups: dataset categories. Pick only clearly applicable entries',
          '  from groupCandidates (each carries a name, title, and description)',
          '  and return their `name` values, at most 3. The dataset’s current',
          '  groups are always kept — suggest additions only. Never invent a',
          '  group that is not among the candidates; return [] when none fits.',
        ]),
    ...(suggestName
      ? [
          '- name: a URL slug for the dataset derived from the title you wrote:',
          '  lowercase ASCII letters, digits and hyphens only (romanize Japanese',
          '  words), 3–6 short words joined by hyphens, no spaces, no file',
          '  extensions.',
        ]
      : []),
  ].join('\n')
}

/** Serialize the integration material as the user message. */
export function buildDatasetUserContent(materials: DatasetMaterials): string {
  const { pkg, resources, others, tagCandidates, groupCandidates } = materials
  return JSON.stringify(
    {
      dataset: pkg,
      resources,
      ...(others.length && { otherResources: others }),
      tagCandidates,
      groupCandidates,
    },
    null,
    1
  )
}
