/**
 * The `extras_<key>` and `res_extras_<key>` filters (ADR-062): one spelling for
 * the native API's query parameters and the CKAN-compatible API's `fq` fields,
 * which are CKAN's index field names.
 */

import type { SearchFilters } from '@kukan/search-adapter'

/** The most extras conditions one request may carry, dataset and resource together */
const MAX_EXTRAS_CONDITIONS = 20

const PREFIXES = [
  ['extras_', 'extras'],
  ['res_extras_', 'resourceExtras'],
] as const

interface ExtrasField {
  /** The search filter the condition goes to */
  list: keyof ExtrasFilters
  /** The key, as written — CKAN strips what is not `[0-9A-Za-z_-]`; KUKAN strips nothing */
  key: string
}

/** What a parameter or `fq` field names, or undefined where it is no extras filter. */
export function extrasField(name: string): ExtrasField | undefined {
  for (const [prefix, list] of PREFIXES) {
    if (name.startsWith(prefix)) return { list, key: name.slice(prefix.length) }
  }
  return undefined
}

export type ExtrasFilters = Pick<SearchFilters, 'extras' | 'resourceExtras'>

/**
 * Add one condition to `filters`, in place — the `fq` parser builds its filters
 * up term by term. A field without a key, and one past the limit, are refused
 * in the caller's own error shape.
 */
export function addExtrasCondition(
  filters: ExtrasFilters,
  { list, key }: ExtrasField,
  value: string,
  refuse: (why: string) => Error
): void {
  if (!key) throw refuse('An extras filter needs a key')
  ;(filters[list] ??= []).push({ key, value })
  if (
    (filters.extras?.length ?? 0) + (filters.resourceExtras?.length ?? 0) >
    MAX_EXTRAS_CONDITIONS
  ) {
    throw refuse(`At most ${MAX_EXTRAS_CONDITIONS} extras filters are supported`)
  }
}
