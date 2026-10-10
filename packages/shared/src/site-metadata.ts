/**
 * Site-wide custom metadata (ADR-064): flat key → value pairs an admin edits at
 * runtime and the frontend (core and brands) reads by key. The core gives keys
 * no meaning; whatever reads a key decides what it is for.
 */

import { z } from 'zod'

export const SITE_METADATA_MAX_ENTRIES = 100
export const SITE_METADATA_MAX_TEXT_LENGTH = 1000
export const SITE_METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Keys the core may give a meaning to later; brands and sites use the rest */
export const SITE_METADATA_RESERVED_PREFIX = 'kukan-'

export const siteMetadataTypes = ['number', 'text', 'date'] as const
export type SiteMetadataType = (typeof siteMetadataTypes)[number]

const text = z.string().max(SITE_METADATA_MAX_TEXT_LENGTH)

/** A string for every locale, or one per locale (the brand's LocalizedText shape) */
const localizedTextSchema = z.union([
  text,
  z
    .strictObject({ ja: text.optional(), en: text.optional() })
    .refine((map) => map.ja !== undefined || map.en !== undefined, 'Enter at least one language'),
])

/** A real calendar date without a time (2026-02-30 and 2026-6-1 are refused) */
export const siteMetadataDateSchema = z.iso.date()

const key = z.string().regex(SITE_METADATA_KEY_PATTERN, 'Use a-z, 0-9 and hyphens (up to 64)')

export const siteMetadataEntrySchema = z.discriminatedUnion('type', [
  // z.number() refuses Infinity and NaN, which JSON could not carry anyway
  z.object({ key, type: z.literal('number'), value: z.number() }),
  z.object({ key, type: z.literal('text'), value: localizedTextSchema }),
  z.object({ key, type: z.literal('date'), value: siteMetadataDateSchema }),
])

/** Kept as a list so the admin screen's order survives (jsonb objects reorder keys) */
export const siteMetadataSchema = z
  .array(siteMetadataEntrySchema)
  .max(SITE_METADATA_MAX_ENTRIES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>()
    entries.forEach((entry, index) => {
      if (seen.has(entry.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `Duplicate key: ${entry.key}`,
        })
      }
      seen.add(entry.key)
    })
  })

export type SiteMetadataEntry = z.infer<typeof siteMetadataEntrySchema>
export type SiteMetadataValue = SiteMetadataEntry['value']

/**
 * What the public settings API serves: values by key, without their types. A
 * date arrives as its ISO string; whoever reads it decides to treat it as one.
 */
export type SiteMetadataValues = Record<string, SiteMetadataValue>

export function toSiteMetadataValues(entries: SiteMetadataEntry[]): SiteMetadataValues {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
}
