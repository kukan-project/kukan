/**
 * The LLM contract for a resource's abstract (ADR-053).
 *
 * Separate from the suggestion prompts next door, which the abstract shares
 * material and grounding rules with but not shape: a suggestion is proposed to
 * a person who accepts it, and this is published without anyone pressing
 * anything. Two differences follow from that — the dataset's own metadata is
 * passed as context here (§3.2), and the length is asked for in sentences with
 * the reason attached (§7), which is what the measurements said holds.
 */

import { z } from 'zod'
import {
  GROUNDING_RULES,
  OUTPUT_LANGUAGE,
  serializeResource,
  type ResourceMaterial,
} from './prompt'
import type { SummaryLocale } from '@kukan/shared'

/** Re-exported so the prompt and its version are edited in one place */
export { SUMMARY_GENERATION_VERSION } from '@kukan/shared'

/**
 * The dataset around the file. **Context, not material** — it grounds proper
 * nouns the file itself never spells out ("○○市の"), and says which of a
 * dataset's files this one is. A resource with no material is not summarizable
 * because this exists: an abstract rewritten from metadata already on screen
 * says nothing, and asks the model to invent the rest.
 */
export interface SummaryDatasetContext {
  title: string | null
  organization: string | null
  tags: string[]
  /** Capped by the caller: the most useful context and the most parroted */
  notes: string | null
}

export const summaryLlmOutputSchema = z.object({
  summary: z.string(),
  groundedInMaterial: z.boolean(),
})

export type SummaryLlmOutput = z.infer<typeof summaryLlmOutputSchema>

export const SUMMARY_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    groundedInMaterial: { type: 'boolean' },
  },
  required: ['summary', 'groundedInMaterial'],
  additionalProperties: false,
} as const

/**
 * Language-specific wording. The shared rules are about what to say; these are
 * about how that language says it, and they are the reason the prompt version
 * has to move when either is edited.
 */
const LOCALE_RULES: Record<SummaryLocale, string[]> = {
  ja: [
    '- Japanese public-sector documents are written in administrative register.',
    '  Keep the official term and add the word a member of the public would',
    '  actually search with in parentheses after it — 「高齢者（お年寄り）」,',
    '  「就学前児童（小さい子ども）」. One gloss per term, at the first mention.',
    '- Write in である調 or plain declarative sentences; do not address the reader.',
  ],
  en: [
    '- Keep the official term and add the everyday word a member of the public',
    '  would search with in parentheses after it, at the first mention.',
    '- Write plain declarative sentences; do not address the reader.',
  ],
}

export function buildSummarySystemPrompt(locale: SummaryLocale): string {
  return [
    'You are a data-catalog curator. Given one resource (file) of a dataset —',
    'the dataset it belongs to, the file’s own metadata, and material taken',
    'from the file — write a short abstract of that file: what it holds, in',
    'enough detail that a reader can decide whether to open it.',
    '',
    `Write the abstract in ${OUTPUT_LANGUAGE[locale]}.`,
    '',
    'Rules:',
    // Sentences, not characters: asked for in characters, 5 of 6 overshot;
    // asked for in sentences, 6 of 6 held. The reason shortens them further.
    '- Write 3 to 4 sentences. The abstract is also carried on a search vector',
    '  with a limited budget, so say what the file holds and stop. Never pad.',
    '- Say what the metadata does not already say: the content, its',
    '  granularity, what it covers, the vocabulary someone would search it by.',
    '  An abstract that paraphrases the dataset title is worth nothing.',
    '- State nothing the material does not show. In particular, never state a',
    '  period covered, a record count, a maximum or a minimum unless the',
    '  material itself gives it: sample rows are a few rows out of the file,',
    '  not a summary of it.',
    // Measured: given five rows it wrote that a column "was null in the sample
    // rows" — grounded, and meaningless to a reader who was never told there
    // were sample rows. How much was read is on the page already.
    '- Write about the file, never about the material you were given. The',
    '  reader is shown separately how much of the file was read and cannot',
    '  tell what “the sample rows” or “the extracted text” refers to, so',
    '  never mention them. In particular, do not report a column as empty,',
    '  constant or null because the rows you were given are: a handful of',
    '  rows says nothing about the rest. Say nothing about a column you',
    '  cannot characterise.',
    ...GROUNDING_RULES,
    ...LOCALE_RULES[locale],
    '- datasetContext is context, not material. Use it to ground proper nouns',
    '  and to say what this file contributes to the dataset; touching on the',
    '  dataset’s subject is natural, restating its description is not.',
    '- groundedInMaterial: false when the material was too thin to describe the',
    '  file. Say so in the abstract as well, plainly, rather than filling the',
    '  sentences with what the file is likely to contain.',
  ].join('\n')
}

/** The user message: material as JSON, so its text cannot read as instructions */
export function buildSummaryUserContent(
  material: ResourceMaterial,
  context: SummaryDatasetContext
): string {
  return JSON.stringify({ datasetContext: context, resource: serializeResource(material) }, null, 1)
}
