/**
 * `package_search`'s Solr-flavoured parameters, as far as KUKAN's search can
 * answer them.
 *
 * What it cannot answer is refused rather than dropped. A filter quietly
 * ignored returns a superset of what was asked, and a client — a harvester
 * paging on `metadata_modified`, say — has no way to notice.
 */

import type { SearchFilters, SearchQuery } from '@kukan/search-adapter'

/** A refusal in CKAN's validation shape: the parameter, and what is wrong with it. */
export class CkanValidationError extends Error {
  constructor(readonly errors: Record<string, string[]>) {
    super(Object.values(errors).flat().join('; '))
    this.name = 'CkanValidationError'
  }
}

/** The filters an `fq` comes to, or `empty` when it can match nothing. */
export interface ParsedFq {
  filters: Pick<
    SearchFilters,
    | 'organizations'
    | 'ownerOrgIds'
    | 'groups'
    | 'tags'
    | 'formats'
    | 'licenses'
    | 'isPrivate'
    | 'updatedFrom'
    | 'updatedTo'
  >
  empty: boolean
}

/** Split on whitespace outside quotes and range brackets. */
function terms(fq: string, param: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let ranged = false
  for (const ch of fq) {
    if (ch === '"' && !ranged) quoted = !quoted
    else if (ch === '[' && !quoted) ranged = true
    else if (ch === ']' && !quoted) ranged = false
    if (/\s/.test(ch) && !quoted && !ranged) {
      if (current) out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (quoted || ranged) throw new CkanValidationError({ [param]: ['Unbalanced quote or bracket'] })
  if (current) out.push(current)
  return out
}

/**
 * A Solr date: UTC ending in `Z`, as Solr requires — a time without one would be
 * read in the server's zone — or `*` for open, or `NOW`. No date math.
 *
 * Kept to the millisecond, which is all the index holds. A finer end is rounded
 * outward — down for `from`, up for `to` — so a range never loses a dataset it
 * named: CKAN's harvester sends its last run's time to the microsecond, and a
 * repeat is harmless to it where a miss is not.
 */
function solrDate(value: string, param: string, end: 'from' | 'to'): Date | undefined {
  if (value === '*') return undefined
  if (value === 'NOW') return new Date()
  // CKAN writes microseconds; JavaScript reads milliseconds
  const date = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)
    ? new Date(value.replace(/(\.\d{3})\d+/, '$1'))
    : new Date(NaN)
  // JavaScript rolls February 31 over into March; a date that does not read back as written is refused
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new CkanValidationError({ [param]: [`Unsupported date: ${value}`] })
  }
  const finer = /\.\d{3}(\d+)Z$/.exec(value)?.[1]
  return end === 'to' && finer && /[1-9]/.test(finer) ? new Date(date.getTime() + 1) : date
}

/** The facet fields `package_search` can count, and where each is in the search's facets. */
export const FACET_FIELDS = {
  organization: 'organizations',
  groups: 'groups',
  tags: 'tags',
  res_format: 'formats',
  license_id: 'licenses',
} as const

export type FacetField = keyof typeof FACET_FIELDS

/** The `fq` fields that name values, and the search filter each goes to */
const LIST_FIELDS = { ...FACET_FIELDS, owner_org: 'ownerOrgIds' } as const

/**
 * Fields a dataset has one of: two different values cannot both hold, while
 * the search reads a list of them as either.
 */
const SINGLE_VALUED = new Set(['organization', 'owner_org', 'license_id'])

/**
 * Parse `fq` and `fq_list` into search filters.
 *
 * Terms are joined by AND, as CKAN's are, with an optional leading `+`.
 * Supported: `organization`, `owner_org`, `groups`, `tags`, `res_format`,
 * `license_id`, `capacity`, `dataset_type`/`type`, `state` and
 * `metadata_modified:[a TO b]`. OR, negation and grouping are refused — and so
 * is `site_id`: KUKAN has no site identifier to compare one against.
 */
export function parseFq(fq: string | undefined, fqList: string[] = []): ParsedFq {
  const filters: ParsedFq['filters'] = {}
  let empty = false
  const sources = [
    ...(fq ? [{ param: 'fq', text: fq }] : []),
    ...fqList.map((text) => ({ param: 'fq_list', text })),
  ]
  for (const { param, text } of sources) {
    for (const raw of terms(text, param)) {
      const term = raw.startsWith('+') ? raw.slice(1) : raw
      if (term === 'AND' || term === '*:*') continue
      const refuse = (why: string) => new CkanValidationError({ [param]: [`${why}: ${raw}`] })
      if (term === 'OR' || term === 'NOT' || term.startsWith('-') || term.startsWith('(')) {
        throw refuse('Only terms joined by AND are supported')
      }
      const colon = term.indexOf(':')
      if (colon <= 0) throw refuse('Expected field:value')
      const field = term.slice(0, colon)
      let value = term.slice(colon + 1)
      if (value.startsWith('(')) throw refuse('Only terms joined by AND are supported')

      if (field === 'metadata_modified') {
        const range = /^\[(\S+) TO (\S+)\]$/.exec(value)
        if (!range) throw refuse('Expected metadata_modified:[from TO to]')
        const from = solrDate(range[1], param, 'from')
        const to = solrDate(range[2], param, 'to')
        if (from && (!filters.updatedFrom || from > filters.updatedFrom)) filters.updatedFrom = from
        if (to && (!filters.updatedTo || to < filters.updatedTo)) filters.updatedTo = to
        continue
      }

      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1)
      }
      if (field in LIST_FIELDS) {
        const key = LIST_FIELDS[field as keyof typeof LIST_FIELDS]
        const list = filters[key] ?? []
        if (!list.includes(value)) {
          if (SINGLE_VALUED.has(field) && list.length > 0) empty = true
          filters[key] = [...list, value]
        }
      } else if (field === 'capacity') {
        if (value !== 'public' && value !== 'private') throw refuse('Unknown capacity')
        const isPrivate = value === 'private'
        if (filters.isPrivate !== undefined && filters.isPrivate !== isPrivate) empty = true
        filters.isPrivate = isPrivate
      } else if (field === 'dataset_type' || field === 'type') {
        // Every KUKAN dataset is a `dataset`
        if (value !== 'dataset') empty = true
      } else if (field === 'state') {
        // Only active datasets are in the index
        if (value !== 'active') empty = true
      } else {
        throw refuse('Unsupported filter field')
      }
    }
  }
  return { filters, empty }
}

const SORT_FIELDS: Record<string, SearchQuery['sortBy']> = {
  metadata_modified: 'updated',
  metadata_created: 'created',
  name: 'name',
  id: 'id',
}

/**
 * Parse `sort` into what the search can order by: its relevance ranking, which
 * breaks ties on `metadata_modified desc`, or one field.
 *
 * `score` first means relevance — while there is a query to rank by. Without
 * one every score is equal, so the next field decides, as it does in Solr. With
 * one, a tiebreak other than the ranking's own cannot be expressed, and is
 * refused rather than dropped — as is `score` anywhere but first, a tiebreak
 * the search cannot take after a field.
 */
export function parseSort(
  sort: string | undefined,
  hasQuery: boolean
): Pick<SearchQuery, 'sortBy' | 'sortOrder'> {
  if (!sort) return {}
  const clauses = sort.split(',').map((clause) => {
    const [field, dir = 'asc', ...rest] = clause.trim().split(/\s+/)
    if (rest.length > 0 || (dir !== 'asc' && dir !== 'desc')) {
      throw new CkanValidationError({ sort: [`Invalid sort clause: ${clause.trim()}`] })
    }
    if (field === 'score') {
      if (dir !== 'desc') throw new CkanValidationError({ sort: ['Only score desc is supported'] })
    } else if (!SORT_FIELDS[field]) {
      throw new CkanValidationError({ sort: [`Unsupported sort field: ${field}`] })
    }
    return { field, dir }
  })
  if (clauses.slice(1).some((c) => c.field === 'score')) {
    throw new CkanValidationError({ sort: ['score is supported only as the first sort field'] })
  }
  const fields = clauses.filter((c) => c.field !== 'score')
  if (fields.length > 1) {
    throw new CkanValidationError({ sort: ['Only one field besides score is supported'] })
  }
  const [field] = fields
  if (clauses[0].field === 'score' && hasQuery) {
    if (field && !(field.field === 'metadata_modified' && field.dir === 'desc')) {
      throw new CkanValidationError({
        sort: ['With a query, only metadata_modified desc may follow score'],
      })
    }
    return {}
  }
  return field ? { sortBy: SORT_FIELDS[field.field], sortOrder: field.dir as 'asc' | 'desc' } : {}
}

/** `facet.field`: a JSON list over GET, a list in a POST body. */
export function parseFacetFields(value: unknown): FacetField[] {
  if (value === undefined || value === null || value === '') return []
  let list = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      throw new CkanValidationError({ 'facet.field': ['Expected a JSON list'] })
    }
  }
  if (!Array.isArray(list) || !list.every((f) => typeof f === 'string')) {
    throw new CkanValidationError({ 'facet.field': ['Expected a list of field names'] })
  }
  for (const field of list) {
    if (!(field in FACET_FIELDS)) {
      throw new CkanValidationError({ 'facet.field': [`Unsupported facet field: ${field}`] })
    }
  }
  return list as FacetField[]
}
