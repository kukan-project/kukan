/**
 * KUKAN OpenSearch Adapter
 * Full-text search with kuromoji analyzer for Japanese text.
 *
 * Two indices:
 *   kukan-packages  — dataset-level metadata (title, notes, tags, org, …)
 *   kukan-resources  — resource-level metadata + extracted text content
 *
 * Searching with `q` fires an msearch across both indices and merges results.
 */

import { Client } from '@opensearch-project/opensearch'
import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  SearchFilters,
  ResourceCountQuery,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  ResourceDoc,
  MatchedResource,
  IndexStats,
  BrowseResult,
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE } from './adapter'

/** Score multiplier applied to resource hits when merging with package hits */
const RESOURCE_BOOST = 0.4

/** Sanitize OpenSearch highlight output: strip all HTML except <mark> tags */
function sanitizeHighlight(html: string): string {
  return html.replace(/<\/?(?!mark\b)[a-z][^>]*>/gi, '')
}

export interface OpenSearchConfig {
  endpoint: string
  indexPrefix?: string
  auth?: {
    username: string
    password: string
  }
}

export class OpenSearchAdapter implements SearchAdapter {
  private client: Client
  private packagesIndex: string
  private resourcesIndex: string
  private initialized = false

  constructor(config: OpenSearchConfig) {
    this.client = new Client({
      node: config.endpoint,
      ...(config.auth && {
        auth: { username: config.auth.username, password: config.auth.password },
      }),
    })
    const prefix = config.indexPrefix || 'kukan'
    this.packagesIndex = `${prefix}-packages`
    this.resourcesIndex = `${prefix}-resources`
  }

  // ------------------------------------------------------------------
  // Index initialisation
  // ------------------------------------------------------------------

  private static readonly KUROMOJI_SETTINGS = {
    analysis: {
      analyzer: {
        kuromoji_analyzer: {
          type: 'custom' as const,
          tokenizer: 'kuromoji_tokenizer',
          filter: ['kuromoji_baseform', 'kuromoji_part_of_speech', 'lowercase'],
        },
      },
    },
  }

  /** Ensure both indices exist with kuromoji mapping. Idempotent. */
  async ensureIndex(): Promise<void> {
    if (this.initialized) return

    await this.ensurePackagesIndex()
    await this.ensureResourcesIndex()

    this.initialized = true
  }

  private async ensurePackagesIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.packagesIndex })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.packagesIndex,
        body: {
          settings: OpenSearchAdapter.KUROMOJI_SETTINGS,
          mappings: {
            properties: {
              id: { type: 'keyword' },
              name: { type: 'keyword' },
              title: {
                type: 'text',
                analyzer: 'kuromoji_analyzer',
                fields: { keyword: { type: 'keyword' } },
              },
              notes: { type: 'text', analyzer: 'kuromoji_analyzer' },
              tags: { type: 'keyword' },
              organization: { type: 'keyword' },
              license_id: { type: 'keyword' },
              groups: { type: 'keyword' },
              formats: { type: 'keyword' },
              private: { type: 'boolean' },
              owner_org_id: { type: 'keyword' },
              creator_user_id: { type: 'keyword' },
              created: { type: 'date' },
              updated: { type: 'date' },
            },
          },
        },
      })
    }
  }

  private async ensureResourcesIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.resourcesIndex })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.resourcesIndex,
        body: {
          settings: OpenSearchAdapter.KUROMOJI_SETTINGS,
          mappings: {
            properties: {
              id: { type: 'keyword' },
              packageId: { type: 'keyword' },
              name: {
                type: 'text',
                analyzer: 'kuromoji_analyzer',
                fields: { keyword: { type: 'keyword' } },
              },
              description: { type: 'text', analyzer: 'kuromoji_analyzer' },
              format: { type: 'keyword' },
              extractedText: { type: 'text', analyzer: 'kuromoji_analyzer' },
              contentType: { type: 'keyword' },
              contentTruncated: { type: 'boolean' },
              contentOriginalSize: { type: 'integer' },
            },
          },
        },
      })
    }
  }

  // ------------------------------------------------------------------
  // Dataset-level index (kukan-packages)
  // ------------------------------------------------------------------

  async indexPackage(doc: DatasetDoc): Promise<void> {
    await this.ensureIndex()
    await this.client.index({
      index: this.packagesIndex,
      id: doc.id,
      body: doc,
      refresh: 'wait_for',
    })
  }

  async deletePackage(id: string): Promise<void> {
    await this.ensureIndex()
    try {
      await this.client.delete({ index: this.packagesIndex, id, refresh: 'wait_for' })
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404) return
      throw err
    }
  }

  async deleteAllPackages(): Promise<void> {
    await this.ensureIndex()
    await this.client.deleteByQuery({
      index: this.packagesIndex,
      body: { query: { match_all: {} } },
      refresh: true,
    })
  }

  async bulkIndexPackages(docs: DatasetDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.packagesIndex, _id: doc.id } },
      doc,
    ])
    const response = await this.client.bulk({ body, refresh: 'wait_for' })
    if (response.body.errors) {
      const failed = response.body.items.filter(
        (item: { index?: { error?: unknown } }) => item.index?.error
      )
      throw new Error(`Bulk indexing failed for ${failed.length} documents`)
    }
  }

  // ------------------------------------------------------------------
  // Resource-level index (kukan-resources)
  // ------------------------------------------------------------------

  async indexResource(doc: ResourceDoc): Promise<void> {
    await this.ensureIndex()
    await this.client.index({
      index: this.resourcesIndex,
      id: doc.id,
      body: doc,
      refresh: 'wait_for',
    })
  }

  async deleteResource(resourceId: string): Promise<void> {
    await this.ensureIndex()
    try {
      await this.client.delete({ index: this.resourcesIndex, id: resourceId, refresh: 'wait_for' })
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404) return
      throw err
    }
  }

  async deleteAllResources(): Promise<void> {
    await this.ensureIndex()
    await this.client.deleteByQuery({
      index: this.resourcesIndex,
      body: { query: { match_all: {} } },
      refresh: true,
    })
  }

  async bulkIndexResources(docs: ResourceDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.resourcesIndex, _id: doc.id } },
      doc,
    ])
    const response = await this.client.bulk({ body, refresh: 'wait_for' })
    if (response.body.errors) {
      const failed = response.body.items.filter(
        (item: { index?: { error?: unknown } }) => item.index?.error
      )
      throw new Error(`Bulk resource indexing failed for ${failed.length} documents`)
    }
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  /** Build OpenSearch sort clause from query */
  private buildSort(query: SearchQuery): (string | Record<string, unknown>)[] {
    if (query.sortBy) {
      const order = query.sortOrder ?? 'desc'
      return [{ [query.sortBy]: { order } }]
    }
    return query.q?.trim()
      ? ['_score', { updated: { order: 'desc' as const } }]
      : [{ updated: { order: 'desc' as const } }]
  }

  /** Build OpenSearch filter clauses from SearchFilters */
  private buildFilterClauses(filters?: SearchFilters): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = []

    if (filters?.name) {
      clauses.push({ prefix: { name: filters.name } })
    }
    if (filters?.organizations?.length) {
      clauses.push({ terms: { organization: filters.organizations } })
    }
    if (filters?.tags?.length) {
      for (const t of filters.tags) {
        clauses.push({ term: { tags: t } })
      }
    }
    if (filters?.formats?.length) {
      for (const fmt of filters.formats) {
        clauses.push({ term: { formats: fmt.toUpperCase() } })
      }
    }
    if (filters?.licenses?.length) {
      clauses.push({ terms: { license_id: filters.licenses } })
    }
    if (filters?.groups?.length) {
      for (const g of filters.groups) {
        clauses.push({ term: { groups: g } })
      }
    }
    if (filters?.excludePrivate) {
      if (filters.allowPrivateOrgIds?.length) {
        clauses.push({
          bool: {
            should: [
              { term: { private: false } },
              { terms: { owner_org_id: filters.allowPrivateOrgIds } },
            ],
            minimum_should_match: 1,
          },
        })
      } else {
        clauses.push({ term: { private: false } })
      }
    }
    if (filters?.ownerOrgIds?.length) {
      clauses.push({ terms: { owner_org_id: filters.ownerOrgIds } })
    }
    if (filters?.isPrivate !== undefined) {
      clauses.push({ term: { private: filters.isPrivate } })
    }
    if (filters?.creatorUserId) {
      clauses.push({ term: { creator_user_id: filters.creatorUserId } })
    }

    return clauses
  }

  /** Build a package-level multi_match query clause */
  private buildPackageMultiMatch(q: string): Record<string, unknown> {
    return {
      multi_match: {
        query: q,
        fields: ['title^3', 'name^2', 'notes', 'tags'],
        type: 'cross_fields',
        operator: 'and',
      },
    }
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    await this.ensureIndex()

    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    const hasQuery = Boolean(query.q?.trim())

    // Build packages query
    const must: Record<string, unknown>[] = []
    const filter = this.buildFilterClauses(query.filters)

    if (hasQuery) {
      must.push(this.buildPackageMultiMatch(query.q!))
    } else {
      must.push({ match_all: {} })
    }

    const aggs = query.facets
      ? {
          organizations: { terms: { field: 'organization', size: 200 } },
          tags: { terms: { field: 'tags', size: 200 } },
          formats: { terms: { field: 'formats', size: 200 } },
          licenses: { terms: { field: 'license_id', size: 200 } },
          groups: { terms: { field: 'groups', size: 200 } },
        }
      : undefined

    const packagesHighlight = hasQuery
      ? {
          highlight: {
            fields: {
              title: { number_of_fragments: 0, pre_tags: ['<mark>'], post_tags: ['</mark>'] },
              notes: {
                fragment_size: 200,
                number_of_fragments: 1,
                pre_tags: ['<mark>'],
                post_tags: ['</mark>'],
              },
            },
          },
        }
      : {}

    const packagesBody = {
      from: offset,
      size: limit,
      query: { bool: { must, ...(filter.length > 0 && { filter }) } },
      sort: this.buildSort(query),
      ...(aggs && { aggs }),
      ...packagesHighlight,
    }

    // If no full-text query, skip resource search entirely
    if (!hasQuery) {
      const response = await this.client.search({ index: this.packagesIndex, body: packagesBody })
      return this.parsePackagesResponse(response, query, offset, limit)
    }

    // msearch: packages + resources in parallel
    const resourcesBody = {
      from: 0,
      size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
      query: {
        multi_match: {
          query: query.q!,
          fields: ['name^3', 'description^2', 'extractedText'],
          type: 'cross_fields' as const,
          operator: 'and' as const,
        },
      },
      highlight: {
        fields: {
          name: { number_of_fragments: 0, pre_tags: ['<mark>'], post_tags: ['</mark>'] },
          description: {
            fragment_size: 200,
            number_of_fragments: 1,
            pre_tags: ['<mark>'],
            post_tags: ['</mark>'],
          },
          extractedText: {
            fragment_size: 150,
            number_of_fragments: 3,
            pre_tags: ['<mark>'],
            post_tags: ['</mark>'],
          },
        },
      },
    }

    const msearchResponse = await this.client.msearch({
      body: [
        { index: this.packagesIndex },
        packagesBody,
        { index: this.resourcesIndex },
        resourcesBody,
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [packagesResult, resourcesResult] = msearchResponse.body.responses as any[]

    // Parse packages
    const result = this.parsePackagesResponse({ body: packagesResult }, query, offset, limit)

    // Parse resources and merge
    const resourceHits = resourcesResult.hits?.hits ?? []
    if (resourceHits.length > 0) {
      await this.mergeResourceHits(result, resourceHits)
    }

    return result
  }

  /** Parse a packages search response into SearchResult */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parsePackagesResponse(
    response: any,
    query: SearchQuery,
    offset: number,
    limit: number
  ): SearchResult {
    const hits = response.body.hits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: DatasetDoc[] = (hits?.hits ?? []).map((hit: any) => {
      const doc: DatasetDoc = {
        ...hit._source,
        id: hit._id,
        _score: hit._score ?? 0,
      }
      // Attach highlighted fields if available
      if (hit.highlight?.title?.[0])
        doc.highlightedTitle = sanitizeHighlight(hit.highlight.title[0])
      if (hit.highlight?.notes?.[0])
        doc.highlightedNotes = sanitizeHighlight(hit.highlight.notes[0])
      return doc
    })

    const total = hits?.total
    const totalCount = typeof total === 'number' ? total : (total?.value ?? 0)

    let facets: SearchFacets | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggregations = response.body.aggregations as Record<string, any> | undefined
    if (query.facets && aggregations) {
      const parseBuckets = (aggName: string): SearchFacetBucket[] =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aggregations[aggName]?.buckets ?? []).map((b: any) => ({
          name: b.key as string,
          count: b.doc_count as number,
        }))

      facets = {
        organizations: parseBuckets('organizations'),
        tags: parseBuckets('tags'),
        formats: parseBuckets('formats'),
        licenses: parseBuckets('licenses'),
        groups: parseBuckets('groups'),
      }
    }

    return { items, total: totalCount, offset, limit, ...(facets && { facets }) }
  }

  /** Merge resource hits into a packages SearchResult */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mergeResourceHits(result: SearchResult, resourceHits: any[]): Promise<void> {
    // Group resource hits by packageId
    const byPackage = new Map<string, MatchedResource[]>()
    const packageScores = new Map<string, number>()

    for (const hit of resourceHits) {
      const src = hit._source
      const pkgId = src.packageId as string
      const score = (hit._score as number) ?? 0

      const rawContentHighlights = hit.highlight?.extractedText as string[] | undefined
      const contentSnippets = rawContentHighlights?.length
        ? rawContentHighlights.map(sanitizeHighlight)
        : undefined
      const highlightedName = (hit.highlight?.name as string[] | undefined)?.[0]
        ? sanitizeHighlight((hit.highlight.name as string[])[0])
        : undefined
      const highlightedDescription = (hit.highlight?.description as string[] | undefined)?.[0]
        ? sanitizeHighlight((hit.highlight.description as string[])[0])
        : undefined
      const hasContentMatch = Boolean(contentSnippets)

      const matched: MatchedResource = {
        id: src.id,
        name: src.name,
        description: src.description,
        format: src.format,
        ...(highlightedName && { highlightedName }),
        ...(highlightedDescription && { highlightedDescription }),
        ...(contentSnippets && { contentSnippets }),
        matchSource: hasContentMatch ? 'content' : 'metadata',
      }

      if (!byPackage.has(pkgId)) {
        byPackage.set(pkgId, [])
        packageScores.set(pkgId, 0)
      }
      byPackage.get(pkgId)!.push(matched)
      packageScores.set(pkgId, Math.max(packageScores.get(pkgId)!, score))
    }

    // Attach matchedResources to existing items and adjust scores
    const existingIds = new Set(result.items.map((item) => item.id))
    for (const item of result.items) {
      const resources = byPackage.get(item.id)
      if (resources) {
        item.matchedResources = resources
        const existingScore = (item as DatasetDoc & { _score?: number })._score ?? 0
        const resourceScore = packageScores.get(item.id) ?? 0
        ;(item as DatasetDoc & { _score?: number })._score =
          existingScore + resourceScore * RESOURCE_BOOST
      }
    }

    // Add packages found only via resource content (not in packages result)
    const contentOnlyPackageIds: string[] = []
    for (const pkgId of byPackage.keys()) {
      if (!existingIds.has(pkgId)) {
        contentOnlyPackageIds.push(pkgId)
      }
    }

    if (contentOnlyPackageIds.length > 0) {
      try {
        await this.fetchAndAppendMissingPackages(
          result,
          contentOnlyPackageIds,
          byPackage,
          packageScores
        )
      } catch {
        // Best-effort: if mget fails, we still return the packages we have
      }
    }

    // Re-sort by _score descending
    result.items.sort((a, b) => {
      const sa = (a as DatasetDoc & { _score?: number })._score ?? 0
      const sb = (b as DatasetDoc & { _score?: number })._score ?? 0
      return sb - sa
    })

    // Clean up internal _score from response
    for (const item of result.items) {
      delete (item as Record<string, unknown>)._score
    }
  }

  /** Fetch packages not in the main result but matched via resources */
  private async fetchAndAppendMissingPackages(
    result: SearchResult,
    packageIds: string[],
    byPackage: Map<string, MatchedResource[]>,
    packageScores: Map<string, number>
  ): Promise<void> {
    const mgetResponse = await this.client.mget({
      index: this.packagesIndex,
      body: { ids: packageIds },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const doc of mgetResponse.body.docs as any[]) {
      if (!doc.found) continue
      const item: DatasetDoc = { ...doc._source, id: doc._id }
      item.matchedResources = byPackage.get(doc._id)
      const resourceScore = packageScores.get(doc._id) ?? 0
      ;(item as DatasetDoc & { _score?: number })._score = resourceScore * RESOURCE_BOOST
      result.items.push(item)
      result.total += 1
    }
  }

  // ------------------------------------------------------------------
  // Resource count
  // ------------------------------------------------------------------

  async sumResourceCount(query?: ResourceCountQuery): Promise<number> {
    await this.ensureIndex()

    // Count resource documents matching packages that satisfy the query/filters.
    // Step 1: find matching package IDs
    const must: Record<string, unknown>[] = []
    const filter = this.buildFilterClauses(query?.filters)

    if (query?.q?.trim()) {
      must.push(this.buildPackageMultiMatch(query.q))
    } else {
      must.push({ match_all: {} })
    }

    const pkgResponse = await this.client.search({
      index: this.packagesIndex,
      body: {
        size: 0,
        query: { bool: { must, ...(filter.length > 0 && { filter }) } },
        aggs: {
          package_ids: { terms: { field: 'id', size: 10000 } },
        },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkgAggs = pkgResponse.body.aggregations as Record<string, any> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const packageBuckets = pkgAggs?.package_ids?.buckets as any[] | undefined
    if (!packageBuckets || packageBuckets.length === 0) return 0

    const packageIds = packageBuckets.map((b: { key: string }) => b.key)

    // Step 2: count resources belonging to those packages
    const countResponse = await this.client.count({
      index: this.resourcesIndex,
      body: {
        query: { terms: { packageId: packageIds } },
      },
    })

    return (countResponse.body.count as number) ?? 0
  }

  // ------------------------------------------------------------------
  // Index stats
  // ------------------------------------------------------------------

  async getIndexStats(): Promise<IndexStats> {
    await this.ensureIndex()

    const [catResponse, recentResponse] = await Promise.all([
      this.client.cat.indices({
        index: [this.packagesIndex, this.resourcesIndex],
        format: 'json',
        h: ['index', 'docs.count', 'store.size'],
      }),
      this.client.msearch({
        body: [
          { index: this.packagesIndex },
          {
            size: 5,
            sort: [{ updated: { order: 'desc' } }],
            _source: ['name', 'title', 'updated'],
          },
          { index: this.resourcesIndex },
          { size: 5, sort: [{ _doc: { order: 'desc' } }], _source: ['name', 'packageId'] },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ])

    const indices = catResponse.body as Array<{
      index: string
      'docs.count': string
      'store.size': string
    }>

    const parseCatEntry = (indexName: string) => {
      const row = indices.find((i) => i.index === indexName)
      return {
        docCount: parseInt(row?.['docs.count'] ?? '0', 10),
        sizeBytes: parseSizeToBytes(row?.['store.size'] ?? '0b'),
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [pkgRecent, resRecent] = recentResponse.body.responses as any[]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkgRecentDocs = (pkgRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: (h._source.title ?? h._source.name) as string | undefined,
      updated: h._source.updated as string | undefined,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resRecentDocs = (resRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: h._source.name as string | undefined,
    }))

    return {
      packages: { ...parseCatEntry(this.packagesIndex), recentDocs: pkgRecentDocs },
      resources: { ...parseCatEntry(this.resourcesIndex), recentDocs: resRecentDocs },
    }
  }

  private resolveIndex(index: 'packages' | 'resources'): string {
    return index === 'packages' ? this.packagesIndex : this.resourcesIndex
  }

  async getDocument(
    index: 'packages' | 'resources',
    id: string
  ): Promise<Record<string, unknown> | null> {
    await this.ensureIndex()
    try {
      const response = await this.client.get({ index: this.resolveIndex(index), id })
      return response.body._source as Record<string, unknown>
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404)
        return null
      throw err
    }
  }

  async browseDocuments(
    index: 'packages' | 'resources',
    options: { q?: string; offset?: number; limit?: number }
  ): Promise<BrowseResult> {
    await this.ensureIndex()

    const offset = options.offset ?? 0
    const limit = Math.min(options.limit ?? 20, 100)
    const indexName = this.resolveIndex(index)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      from: offset,
      size: limit,
      sort: [{ _doc: { order: 'desc' } }],
      _source: { excludes: ['extractedText'] },
    }

    if (options.q?.trim()) {
      body.query = {
        multi_match: {
          query: options.q,
          fields:
            index === 'packages'
              ? ['title', 'name', 'notes']
              : ['name', 'description', 'extractedText'],
          type: 'cross_fields' as const,
          operator: 'and' as const,
        },
      }
      body.sort = ['_score', { _doc: { order: 'desc' } }]
    }

    const response = await this.client.search({ index: indexName, body })
    const hits = response.body.hits
    const total = typeof hits.total === 'number' ? hits.total : (hits.total?.value ?? 0)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (hits.hits ?? []).map((hit: any) => ({
      id: hit._id as string,
      source: hit._source as Record<string, unknown>,
    }))

    return { items, total, offset, limit }
  }
}

/** Parse OpenSearch human-readable size (e.g. "12.5kb", "1.2mb") to bytes */
function parseSizeToBytes(size: string): number {
  const match = size.match(/^([\d.]+)(b|kb|mb|gb)$/i)
  if (!match) return 0
  const value = parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }
  return Math.round(value * (multipliers[unit] ?? 1))
}
