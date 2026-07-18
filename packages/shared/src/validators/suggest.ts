/**
 * KUKAN AI Metadata Suggestion Validators (ADR-040)
 * Request/response contracts of the suggest-metadata endpoint. The raw LLM
 * output shape is internal to the API package (services/suggest/prompt.ts).
 */

import { z } from 'zod'

export const suggestMetadataRequestSchema = z.object({
  // Generation language follows the site locale; the client passes it explicitly
  locale: z.enum(['ja', 'en']).default('ja'),
})

export interface SuggestedTag {
  name: string
  /** True when the tag is not among the site's existing tag candidates */
  isNew: boolean
}

export interface MetadataSuggestion {
  title: string
  notes: string
  tags: SuggestedTag[]
  /** Suggested category memberships — names of existing groups only (the LLM
   *  picks from a closed candidate list; it never creates groups) */
  groups: string[]
  /** Suggested URL identifier (slug), drafts only — changing a published
   *  dataset's name would break external links. Omitted when the generated
   *  slug cannot be normalized into a valid unique name */
  name?: string
  /** Per-resource name and description proposals (adopted individually) */
  resources: { id: string; name: string; description: string }[]
}

/** Response of POST /api/v1/packages/:nameOrId/suggest-metadata */
export interface SuggestMetadataResponse {
  suggestion: MetadataSuggestion
  generatedBy: { provider: string; model: string }
  /** Resources whose content material made it into the prompt */
  usedResources: string[]
  /** Resources that contributed metadata only (pipeline not complete,
   *  unsupported format, read failure, or prompt-budget trimming) */
  skippedResources: string[]
}
