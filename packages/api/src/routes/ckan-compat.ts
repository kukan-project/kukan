/**
 * KUKAN CKAN-Compatible API Routes
 * /api/3/action/* and /api/action/* (CKAN Action API, as CKAN 2.12 serves it)
 *
 * Read-only. Each action answers GET with its parameters in the query string
 * and POST with them in a JSON or form body — ckanapi posts by default — and
 * fails the way CKAN does: a JSON envelope whose `error.__type` names the kind,
 * with CKAN's status codes (409 for validation).
 */

import { Hono, type Context } from 'hono'
import { KukanError, LICENSES, publicOrigin } from '@kukan/shared'
import type { SearchFacets, SearchFilters } from '@kukan/search-adapter'
import { PackageService } from '../services/package-service'
import { ResourceService, omitStoragePointers } from '../services/resource-service'
import { OrganizationService } from '../services/organization-service'
import { GroupService } from '../services/group-service'
import { TagService } from '../services/tag-service'
import { resolveUserOrgIds, buildVisibilityFilters } from '../auth/permissions'
import { publicCache } from '../middleware/cache-control'
import { ckanTokenAuth } from '../middleware/auth'
import type { AppContext } from '../context'
import {
  toCkanGroup,
  toCkanGroupSummary,
  toCkanPackage,
  toCkanResource,
  toCkanTag,
  ckanExtrasList,
} from './ckan/format'
import {
  CkanValidationError,
  FACET_FIELDS,
  parseFacetFields,
  parseFq,
  parseSort,
  type FacetField,
} from './ckan/search-params'

type Ctx = Context<{ Variables: AppContext }>
type Params = Record<string, unknown>

export const ckanCompatRouter = new Hono<{ Variables: AppContext }>()
ckanCompatRouter.use('*', ckanTokenAuth())

/** CKAN's default and ceiling for `package_search` rows (`ckan.search.rows_max`) */
const DEFAULT_ROWS = 10
const MAX_ROWS = 1000
/** CKAN's `ckan.group_and_organization_list_max` / `_all_fields_max` */
const GROUP_LIST_MAX = 1000
const GROUP_LIST_ALL_FIELDS_MAX = 25
/** The search counts at most this many values per facet field */
const FACET_LIMIT_MAX = 200
/** CKAN's `organization_show` / `group_show` return at most this many datasets */
const ORGANIZATION_DATASETS = 10
const GROUP_DATASETS = 1000

class CkanNotFound extends Error {}

/** A request CKAN answers with 400 and a bare message, not an envelope. */
class CkanBadRequest extends Error {}

// ============================================================
// Parameters
// ============================================================

/**
 * An action's parameters, as CKAN reads them: the query string over GET (a key
 * given twice becomes a list), the body over POST — JSON, or a form, including
 * the old clients' form whose one key is the JSON body itself.
 */
async function actionParams(c: Ctx): Promise<Params> {
  if (c.req.method === 'GET') {
    const out: Params = {}
    for (const [key, values] of Object.entries(c.req.queries())) {
      out[key] = values.length === 1 ? values[0] : values
    }
    return out
  }
  const type = c.req.header('Content-Type') ?? ''
  // CKAN reads multipart for file uploads, which no action here takes
  if (type.includes('multipart/form-data')) {
    throw new CkanBadRequest('multipart/form-data is not accepted by read actions')
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody({ all: true })
    // Only a key that is a JSON object — `id=1` is an id
    const entries = Object.entries(form)
    if (
      entries.length === 1 &&
      (entries[0][1] === '' || entries[0][1] === '1') &&
      entries[0][0].trimStart().startsWith('{')
    ) {
      return parseJsonBody(entries[0][0])
    }
    return form as Params
  }
  return parseJsonBody(await c.req.text())
}

function parseJsonBody(text: string): Params {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CkanBadRequest(`JSON Error: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CkanBadRequest('JSON Error: Request data JSON decoded to a non-dict')
  }
  return parsed as Params
}

function stringParam(params: Params, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new CkanValidationError({ [key]: ['Must be a string'] })
  return value
}

function requiredParam(params: Params, key: string): string {
  const value = stringParam(params, key)
  if (value === undefined) throw new CkanValidationError({ [key]: ['Missing value'] })
  return value
}

function intParam(params: Params, key: string, fallback: number, min = 0): number {
  const value = params[key]
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n)) throw new CkanValidationError({ [key]: ['Invalid integer'] })
  if (n < min) throw new CkanValidationError({ [key]: [`Must be at least ${min}`] })
  return n
}

/** CKAN's `asbool`: true, or the strings it reads as true */
function boolParam(params: Params, key: string, fallback = false): boolean {
  const value = params[key]
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).toLowerCase()
  if (['true', 'yes', 'on', 'y', 't', '1'].includes(text)) return true
  if (['false', 'no', 'off', 'n', 'f', '0'].includes(text)) return false
  throw new CkanValidationError({ [key]: ['Invalid boolean'] })
}

/**
 * A list: repeated query keys, a body array, or one string — a JSON array, or
 * with `separator` the comma-separated form CKAN's `aslist` reads.
 */
function listParam(params: Params, key: string, separator?: string): string[] {
  const value = params[key]
  if (value === undefined || value === null || value === '') return []
  let list: unknown[]
  if (Array.isArray(value)) {
    list = value
  } else if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try {
      list = JSON.parse(value)
    } catch {
      throw new CkanValidationError({ [key]: ['Invalid JSON list'] })
    }
    if (!Array.isArray(list)) throw new CkanValidationError({ [key]: ['Not a list'] })
  } else if (typeof value === 'string' && separator) {
    list = value
      .split(separator)
      .map((v) => v.trim())
      .filter(Boolean)
  } else {
    list = [value]
  }
  if (!list.every((v) => typeof v === 'string')) {
    throw new CkanValidationError({ [key]: ['Must be a list of strings'] })
  }
  return list
}

// ============================================================
// Envelope
// ============================================================

function origin(c: Ctx): string {
  return publicOrigin(c.get('env'))
}

function helpUrl(c: Ctx, action: string): string {
  return `${origin(c)}/api/3/action/help_show?name=${encodeURIComponent(action)}`
}

function ckanFailure(c: Ctx, action: string, err: unknown) {
  const help = helpUrl(c, action)
  if (err instanceof CkanBadRequest) return c.json(`Bad request: ${err.message}`, 400)
  if (err instanceof CkanValidationError) {
    return c.json(
      { help, success: false, error: { ...err.errors, __type: 'Validation Error' } },
      409
    )
  }
  const status = err instanceof KukanError ? err.status : 500
  if (err instanceof CkanNotFound || status === 404) {
    const message = err instanceof KukanError ? err.message : ''
    return c.json(
      {
        help,
        success: false,
        error: {
          __type: 'Not Found Error',
          message: message ? `Not found: ${message}` : 'Not found',
        },
      },
      404
    )
  }
  if (status === 401 || status === 403) {
    return c.json(
      { help, success: false, error: { __type: 'Authorization Error', message: 'Access denied' } },
      403
    )
  }
  if (status === 400 && err instanceof Error) {
    return c.json(
      { help, success: false, error: { message: [err.message], __type: 'Validation Error' } },
      409
    )
  }
  c.get('logger').error({ err, action }, 'CKAN-compatible action failed')
  return c.json(
    {
      help,
      success: false,
      error: { __type: 'Internal Server Error', message: 'Internal Server Error' },
    },
    500
  )
}

/** Every registered action, for `help_show` */
const ACTIONS = new Set<string>()

/**
 * Register an action on GET and POST. `cache` marks a result that is the same
 * for every anonymous caller (`publicCache`).
 */
function action(
  name: string,
  handler: (c: Ctx, params: Params) => Promise<unknown> | unknown,
  { cache }: { cache?: [maxAge: number, swr: number] } = {}
) {
  ACTIONS.add(name)
  if (cache) ckanCompatRouter.use(`/${name}`, publicCache(...cache))
  ckanCompatRouter.on(['GET', 'POST'], `/${name}`, async (c) => {
    let result: unknown
    try {
      result = await handler(c, await actionParams(c))
    } catch (err) {
      return ckanFailure(c, name, err)
    }
    return c.json({ help: helpUrl(c, name), success: true, result })
  })
}

// ============================================================
// Package Actions
// ============================================================

// package_list - names of the active public datasets, by name. Public only for
// every caller, sysadmins included, as CKAN has it.
action(
  'package_list',
  async (c, params) => {
    const limit = params.limit === undefined ? undefined : intParam(params, 'limit', 0, 1)
    const offset = intParam(params, 'offset', 0)
    return new PackageService(c.get('db')).listPublicNames(limit, offset)
  },
  { cache: [60, 300] }
)

action('package_show', async (c, params) => {
  const id = requiredParam(params, 'id')
  const pkg = await new PackageService(c.get('db')).getDetailByNameOrId(id, c.get('user'))
  return toCkanPackage(pkg, origin(c))
})

interface PackageSearchArgs {
  q: string
  filters: SearchFilters
  /** Private datasets the caller may read too — in the search and in the rows read back alike */
  includePrivate: boolean
  rows: number
  start?: number
  sort?: ReturnType<typeof parseSort>
  /** The facet fields to count; titles are read for `organization` and `groups` among them */
  facets?: FacetField[]
  /** Name the values the caller can see that no result carries, at 0 (`facet.mincount=0`) */
  zeroFacets?: boolean
}

/**
 * Search, then read each result whole from the database, as `package_show`
 * serves it — the index ranks and filters, the database answers. Shared by
 * `package_search` and the datasets `organization_show` / `group_show` include.
 */
/** The search's facet counts with every value the caller can see added at 0, and their titles */
async function withZeroCounts(c: Ctx, counted: SearchFacets, includePrivate: boolean) {
  const all = await new PackageService(c.get('db')).enrichFacets(counted, readAs(c, includePrivate))
  return {
    counts: all,
    titles: {
      organizations: new Map(all.organizations.map((o) => [o.name, o.title])),
      groups: new Map(all.groups.map((g) => [g.name, g.title])),
    },
  }
}

async function searchPackages(c: Ctx, args: PackageSearchArgs) {
  const result = await c.get('search').search({
    q: args.q,
    offset: args.start ?? 0,
    limit: args.rows,
    filters: { ...args.filters, ...(await searchVisibility(c, args.includePrivate)) },
    facets: !!args.facets?.length,
    ...args.sort,
  })
  const service = new PackageService(c.get('db'))
  // The search counted under the caller's visibility, so a value it names is one
  // the caller may see; only the organizations' and groups' titles are read.
  // Zero counts need the values no result carries, so every visible one is read
  const facets =
    result.facets &&
    (args.zeroFacets
      ? withZeroCounts(c, result.facets, args.includePrivate)
      : service
          .facetTitles({
            organizations: args.facets?.includes('organization') ? result.facets.organizations : [],
            groups: args.facets?.includes('groups') ? result.facets.groups : [],
          })
          .then((titles) => ({ counts: result.facets!, titles })))
  const [packages, facetResult] = await Promise.all([
    // Read back under the same visibility: the index can still rank a dataset
    // made private since, and this check is what keeps it out
    service.getDetailsByIds(
      result.items.map((item) => item.id),
      readAs(c, args.includePrivate)
    ),
    facets,
  ])
  return {
    // The index's count, the same on every page and true to its pages: a
    // client paging by it reaches every result. While the index lags, a page
    // can hold fewer than it ranked; filling it would shift the next one and
    // repeat a dataset, and a visible total would need every id checked.
    count: result.total,
    results: packages.map((pkg) => toCkanPackage(pkg, origin(c))),
    facets: facetResult?.counts,
    titles: facetResult?.titles,
  }
}

/**
 * The visibility a search runs under. Private datasets only on request, as
 * CKAN has it — and then only those the caller may read.
 */
/** Who a search reads as: the caller with private datasets included, else no one — public only */
function readAs(c: Ctx, includePrivate: boolean) {
  return includePrivate ? c.get('user') : undefined
}

async function searchVisibility(c: Ctx, includePrivate: boolean): Promise<SearchFilters> {
  if (!includePrivate) return { excludePrivate: true }
  const user = c.get('user')
  return buildVisibilityFilters(user, await resolveUserOrgIds(c.get('db'), user))
}

// package_search - keyword search (no hybrid fusion: CKAN's predictable
// semantics), with the parts of Solr's syntax that search-params.ts reads
action('package_search', async (c, params) => {
  const rawQ = stringParam(params, 'q') ?? ''
  const q = rawQ === '*:*' ? '' : rawQ
  const fq = parseFq(stringParam(params, 'fq'), listParam(params, 'fq_list'))
  const sortText = stringParam(params, 'sort')
  const sort = parseSort(sortText, q !== '')
  const rows = Math.min(intParam(params, 'rows', DEFAULT_ROWS), MAX_ROWS)
  const start = intParam(params, 'start', 0)
  const facetEnabled = boolParam(params, 'facet', true)
  const facetFields = facetEnabled ? parseFacetFields(params['facet.field']) : []
  const facetLimitRaw = intParam(params, 'facet.limit', 50, -1)
  const facetLimit = facetLimitRaw < 0 ? FACET_LIMIT_MAX : Math.min(facetLimitRaw, FACET_LIMIT_MAX)
  const facetMinCount = intParam(params, 'facet.mincount', 1)

  const includePrivate = boolParam(params, 'include_private')
  // An fq that can match nothing is answered without a search — but its zero
  // counts are what an unmatched search's would be
  const zeroOnly =
    fq.empty && facetFields.length > 0 && facetMinCount === 0
      ? await withZeroCounts(
          c,
          {
            organizations: [],
            groups: [],
            tags: [],
            formats: [],
            licenses: [],
          },
          includePrivate
        )
      : undefined
  const { count, results, facets, titles } = fq.empty
    ? { count: 0, results: [], facets: zeroOnly?.counts, titles: zeroOnly?.titles }
    : await searchPackages(c, {
        q,
        filters: fq.filters,
        includePrivate,
        rows,
        start,
        sort,
        facets: facetFields,
        zeroFacets: facetMinCount === 0,
      })

  const facetItems = (field: FacetField) =>
    [...(facets?.[FACET_FIELDS[field]] ?? [])]
      .filter((item) => item.count >= facetMinCount)
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
      .slice(0, facetLimit)
      .map((item) => ({
        name: item.name,
        display_name:
          (field === 'organization' && titles?.organizations.get(item.name)) ||
          (field === 'groups' && titles?.groups.get(item.name)) ||
          item.name,
        count: item.count,
      }))
  const items = facetFields.map((field) => [field, facetItems(field)] as const)
  return {
    count,
    facets: Object.fromEntries(
      items.map(([field, list]) => [field, Object.fromEntries(list.map((i) => [i.name, i.count]))])
    ),
    results,
    sort: sortText ?? 'score desc, metadata_modified desc',
    search_facets: Object.fromEntries(
      items.map(([field, list]) => [field, { title: field, items: list }])
    ),
  }
})

// ============================================================
// Resource Actions
// ============================================================

action('resource_show', async (c, params) => {
  const id = requiredParam(params, 'id')
  const resource = await new ResourceService(c.get('db')).getByIdWithAccessCheck(id, c.get('user'))
  return toCkanResource(omitStoragePointers(resource), origin(c))
})

// ============================================================
// Organization / Group Actions
// ============================================================

/** `packages` is CKAN's older name for `package_count` */
const GROUP_SORT_FIELDS = {
  name: 'name',
  title: 'title',
  package_count: 'datasetCount',
  packages: 'datasetCount',
} as const

/** `organization_list` / `group_list`, ordered and paged in the database */
async function listGroups(c: Ctx, params: Params, isOrganization: boolean) {
  const allFields = boolParam(params, 'all_fields')
  const max = allFields ? GROUP_LIST_ALL_FIELDS_MAX : GROUP_LIST_MAX
  const sortText = stringParam(params, 'sort') ?? 'title asc'
  const [sortField, givenOrder] = sortText.trim().split(/\s+/)
  // A bare count sort is busiest first in CKAN, kept from before it took a direction
  const sortOrder =
    givenOrder ?? (sortField === 'packages' || sortField === 'package_count' ? 'desc' : 'asc')
  if (!(sortField in GROUP_SORT_FIELDS) || (sortOrder !== 'asc' && sortOrder !== 'desc')) {
    throw new CkanValidationError({ sort: [`Unsupported sort: ${sortText}`] })
  }
  const query = {
    offset: intParam(params, 'offset', 0),
    limit: Math.min(intParam(params, 'limit', max), max),
    q: stringParam(params, 'q'),
    orderBy: GROUP_SORT_FIELDS[sortField as keyof typeof GROUP_SORT_FIELDS],
    sortOrder: sortOrder as 'asc' | 'desc',
    names: listParam(params, isOrganization ? 'organizations' : 'groups', ','),
  } as const

  const db = c.get('db')
  const { items } = isOrganization
    ? await new OrganizationService(db).list(query, c.get('user'))
    : await new GroupService(db).list(query, c.get('user'))
  if (!allFields) return items.map((r) => r.name)
  const includeExtras = boolParam(params, 'include_extras')
  return items.map((r) => ({
    ...toCkanGroupSummary(r, isOrganization, r.datasetCount),
    ...(includeExtras && { extras: ckanExtrasList(r.extras) }),
  }))
}

/**
 * `organization_show` / `group_show`. The count, and the datasets when asked
 * for, come from the search as CKAN's do, under the caller's visibility — the
 * same the lists count with. CKAN caps the datasets at 10 for an organization
 * and 1000 for a group.
 */
async function showGroup(c: Ctx, params: Params, isOrganization: boolean) {
  const id = requiredParam(params, 'id')
  const db = c.get('db')
  const row = isOrganization
    ? await new OrganizationService(db).getByNameOrId(id)
    : await new GroupService(db).getByNameOrId(id)
  const includeDatasets = boolParam(params, 'include_datasets')
  const { count, results } = await searchPackages(c, {
    q: '',
    filters: {
      ...(isOrganization ? { organizations: [row.name] } : { groups: [row.name] }),
    },
    includePrivate: true,
    rows: includeDatasets ? (isOrganization ? ORGANIZATION_DATASETS : GROUP_DATASETS) : 0,
  })
  return {
    ...toCkanGroup(row, isOrganization, count),
    ...(includeDatasets && { packages: results }),
  }
}

action('organization_list', (c, params) => listGroups(c, params, true), { cache: [60, 300] })
action('organization_show', (c, params) => showGroup(c, params, true), { cache: [60, 300] })
action('group_list', (c, params) => listGroups(c, params, false), { cache: [60, 300] })
action('group_show', (c, params) => showGroup(c, params, false), { cache: [60, 300] })

// ============================================================
// Tag Actions
// ============================================================

// tag_list - free tags in use, by name. `vocabulary_id` is refused: KUKAN has
// no vocabulary to name.
action(
  'tag_list',
  async (c, params) => {
    if (stringParam(params, 'vocabulary_id')) {
      throw new CkanValidationError({ vocabulary_id: ['Vocabularies are not supported'] })
    }
    const { items } = await new TagService(c.get('db')).list(
      {
        limit: null,
        // `q` too, as CKAN reads `query or q`
        q: stringParam(params, 'query') ?? stringParam(params, 'q'),
        orderBy: 'name',
        freeOnly: true,
      },
      c.get('user')
    )
    return boolParam(params, 'all_fields') ? items.map(toCkanTag) : items.map((t) => t.name)
  },
  { cache: [60, 300] }
)

action(
  'tag_show',
  async (c, params) => {
    const id = requiredParam(params, 'id')
    const found = await new TagService(c.get('db')).getByNameOrId(id, c.get('user'))
    if (!found) throw new CkanNotFound()
    const tag = toCkanTag(found)
    if (!boolParam(params, 'include_datasets')) return tag
    // The index keeps tags by name alone, so a vocabulary tag's datasets cannot be told from a free tag's
    if (found.vocabularyId) {
      throw new CkanValidationError({
        include_datasets: ['Not supported for a vocabulary tag'],
      })
    }
    // Under the caller's visibility, as the tag itself was found
    const { results } = await searchPackages(c, {
      q: '',
      filters: { tags: [found.name] },
      includePrivate: true,
      rows: MAX_ROWS,
    })
    return { ...tag, packages: results }
  },
  { cache: [60, 300] }
)

// ============================================================
// License Actions
// ============================================================

action('license_list', () => LICENSES, { cache: [3600, 86400] })

// ============================================================
// help_show — what every response's `help` names
// ============================================================

action('help_show', (_c, params) => {
  const name = requiredParam(params, 'name')
  if (!ACTIONS.has(name)) throw new CkanNotFound()
  return `CKAN-compatible action ${name}, read-only. See the KUKAN API documentation for the parameters it reads.`
})

// ============================================================
// Anything else
// ============================================================

ckanCompatRouter.all('/:action', (c) =>
  c.json(`Bad request: Action name not known: ${c.req.param('action')}`, 400)
)
