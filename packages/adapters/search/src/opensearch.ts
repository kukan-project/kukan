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
  ContentDoc,
  MatchedResource,
  IndexStats,
  BrowseResult,
  ContentBrowseResult,
  ContentBrowseItem,
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE } from './adapter'

/** Score multiplier applied to resource hits when merging with package hits */
const RESOURCE_BOOST = 0.4

/** Highlight config for content snippets (shared between search stages) */
const CONTENT_HIGHLIGHT = {
  fields: {
    extractedText: {
      fragment_size: 300,
      number_of_fragments: 1,
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
    },
  },
}

/** Check if an error is an OpenSearch 404 (not found) */
function isNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404)
}

/** Sanitize OpenSearch highlight output: strip all HTML except <mark> tags */
function sanitizeHighlight(html: string): string {
  return html.replace(/<\/?(?!mark\b)[a-z][^>]*>/gi, '')
}

export interface OpenSearchConfig {
  endpoint: string
  indexPrefix?: string
  /** Number of replicas per index shard (default: 0). Set to 1+ for multi-node clusters. */
  replicas?: number
  auth?: {
    username: string
    password: string
  }
}

export class OpenSearchAdapter implements SearchAdapter {
  private client: Client
  private packagesIndex: string
  private resourcesIndex: string
  private contentsIndex: string
  private replicas: number
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
    this.contentsIndex = `${prefix}-contents`
    this.replicas = config.replicas ?? 0
  }

  // ------------------------------------------------------------------
  // Index initialisation
  // ------------------------------------------------------------------

  private static readonly KUROMOJI_ANALYSIS = {
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
    await this.ensureContentsIndex()

    this.initialized = true
  }

  private async ensurePackagesIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.packagesIndex })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.packagesIndex,
        body: {
          settings: {
            number_of_replicas: this.replicas,
            ...OpenSearchAdapter.KUROMOJI_ANALYSIS,
          },
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
          settings: {
            number_of_replicas: this.replicas,
            ...OpenSearchAdapter.KUROMOJI_ANALYSIS,
          },
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
            },
          },
        },
      })
    }
  }

  private async ensureContentsIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.contentsIndex })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.contentsIndex,
        body: {
          settings: {
            number_of_replicas: this.replicas,
            ...OpenSearchAdapter.KUROMOJI_ANALYSIS,
          },
          mappings: {
            properties: {
              resourceId: { type: 'keyword' },
              packageId: { type: 'keyword' },
              extractedText: { type: 'text', analyzer: 'kuromoji_analyzer' },
              contentType: { type: 'keyword' },
              chunkIndex: { type: 'integer' },
              chunkSize: { type: 'integer' },
            },
          },
        },
      })
    }
  }

  /** Delete a single document, ignoring 404 */
  private async deleteDoc(index: string, id: string): Promise<void> {
    try {
      await this.client.delete({ index, id, refresh: 'wait_for' })
    } catch (err: unknown) {
      if (isNotFoundError(err)) return
      throw err
    }
  }

  /** Delete an index and recreate it with latest settings */
  private async recreateIndex(index: string): Promise<void> {
    try {
      await this.client.indices.delete({ index })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
    // Re-create only the deleted index (not all indices) to avoid race conditions
    // when multiple deleteAll* are called in parallel via Promise.all
    this.initialized = false
    if (index === this.packagesIndex) await this.ensurePackagesIndex()
    else if (index === this.resourcesIndex) await this.ensureResourcesIndex()
    else if (index === this.contentsIndex) await this.ensureContentsIndex()
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
    await this.deleteDoc(this.packagesIndex, id)
  }

  async deleteAllPackages(): Promise<void> {
    await this.recreateIndex(this.packagesIndex)
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
    await this.deleteDoc(this.resourcesIndex, resourceId)
  }

  async deleteAllResources(): Promise<void> {
    await this.recreateIndex(this.resourcesIndex)
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
  // Content-level index (kukan-contents)
  // ------------------------------------------------------------------

  async indexContent(doc: ContentDoc): Promise<void> {
    await this.ensureIndex()
    const docId = `${doc.resourceId}_chunk_${doc.chunkIndex}`
    await this.client.index({
      index: this.contentsIndex,
      id: docId,
      body: doc,
      refresh: 'wait_for',
    })
  }

  async deleteContent(resourceId: string): Promise<void> {
    await this.ensureIndex()
    // Delete all chunks for a resource (matches both single-doc and chunked)
    await this.client.deleteByQuery({
      index: this.contentsIndex,
      body: { query: { term: { resourceId } } },
      refresh: true,
    })
  }

  async deleteAllContents(): Promise<void> {
    await this.recreateIndex(this.contentsIndex)
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

    // msearch: packages + resources + contents in parallel
    const resourcesBody = {
      from: 0,
      size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
      query: {
        multi_match: {
          query: query.q!,
          fields: ['name^3', 'description^2'],
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
        },
      },
    }

    // Stage 1: content search WITHOUT highlight (fast — just match + collapse)
    const contentsBody = {
      from: 0,
      size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
      query: {
        match: {
          extractedText: { query: query.q!, operator: 'and' as const },
        },
      },
      _source: ['resourceId', 'packageId'],
      collapse: { field: 'resourceId' },
    }

    const _t: Record<string, number> = {}
    const _mark = (label: string) => { _t[label] = Date.now() }

    _mark('start')
    const msearchResponse = await this.client.msearch({
      body: [
        { index: this.packagesIndex },
        packagesBody,
        { index: this.resourcesIndex },
        resourcesBody,
        { index: this.contentsIndex },
        contentsBody,
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    _mark('msearch')

    const [packagesResult, resourcesResult, contentsResult] =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      msearchResponse.body.responses as any[]

    // Parse packages
    const result = this.parsePackagesResponse({ body: packagesResult }, query, offset, limit)
    _mark('parse')

    // Parse resource metadata matches and merge
    const resourceHits = resourcesResult.hits?.hits ?? []
    if (resourceHits.length > 0) {
      await this.mergeResourceHits(result, resourceHits)
    }
    _mark('mergeRes')

    // Stage 1: merge content matches (no highlights yet)
    const contentHits = contentsResult.hits?.hits ?? []
    if (contentHits.length > 0) {
      await this.mergeContentHits(result, contentHits)
    }
    _mark('mergeContent')

    // Trim to page size before expensive highlight fetch
    if (result.items.length > limit) {
      result.items.sort(
        (a, b) =>
          ((b as DatasetDoc & { _score?: number })._score ?? 0) -
          ((a as DatasetDoc & { _score?: number })._score ?? 0)
      )
      result.items = result.items.slice(0, limit)
    }
    _mark('trim')

    // Stage 2: fetch highlights only for resources in the final result page
    const highlightResourceCount = result.items.reduce(
      (n, item) => n + (item.matchedResources?.filter((r) => r.matchSource === 'content').length ?? 0), 0
    )
    await this.fetchContentHighlights(result, query.q!)
    _mark('highlights')

    // eslint-disable-next-line no-console
    console.log(
      `[search-profile] q="${query.q}" ` +
      `msearch=${_t.msearch - _t.start}ms ` +
      `parse=${_t.parse - _t.msearch}ms ` +
      `mergeRes=${_t.mergeRes - _t.parse}ms(${resourceHits.length}hits) ` +
      `mergeContent=${_t.mergeContent - _t.mergeRes}ms(${contentHits.length}hits) ` +
      `trim=${_t.trim - _t.mergeContent}ms(${result.items.length}items) ` +
      `highlights=${_t.highlights - _t.trim}ms(${highlightResourceCount}resources) ` +
      `total=${_t.highlights - _t.start}ms`
    )

    return result
  }

  /** Parse a packages search response into SearchResult */
  private parsePackagesResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      const highlightedName = (hit.highlight?.name as string[] | undefined)?.[0]
        ? sanitizeHighlight((hit.highlight.name as string[])[0])
        : undefined
      const highlightedDescription = (hit.highlight?.description as string[] | undefined)?.[0]
        ? sanitizeHighlight((hit.highlight.description as string[])[0])
        : undefined

      const matched: MatchedResource = {
        id: src.id,
        name: src.name,
        description: src.description,
        format: src.format,
        ...(highlightedName && { highlightedName }),
        ...(highlightedDescription && { highlightedDescription }),
        matchSource: 'metadata',
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

  /** Merge content hits (collapsed by resourceId, no highlight) into matchedResources */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mergeContentHits(result: SearchResult, contentHits: any[]): Promise<void> {
    const existingMatched = new Map<string, MatchedResource>()
    for (const item of result.items) {
      for (const mr of item.matchedResources ?? []) {
        existingMatched.set(mr.id, mr)
      }
    }

    // Each hit is one per resource (collapsed). No snippets yet — added in stage 2.
    const contentByPackage = new Map<string, MatchedResource[]>()
    const contentByResource = new Map<string, MatchedResource>()

    for (const hit of contentHits) {
      const src = hit._source
      const resourceId = src.resourceId as string
      const pkgId = src.packageId as string

      const existing = existingMatched.get(resourceId)
      if (existing) {
        existing.matchSource = 'content'
        continue
      }

      const matched: MatchedResource = {
        id: resourceId,
        matchSource: 'content',
      }

      contentByResource.set(resourceId, matched)
      if (!contentByPackage.has(pkgId)) contentByPackage.set(pkgId, [])
      contentByPackage.get(pkgId)!.push(matched)
    }

    // Fetch resource metadata (name, description, format) for content-only matches
    const contentOnlyResourceIds = [...contentByResource.keys()].filter(
      (id) => contentByResource.get(id)!.name === undefined
    )
    const _mc0 = Date.now()
    if (contentOnlyResourceIds.length > 0) {
      try {
        const resMget = await this.client.mget({
          index: this.resourcesIndex,
          body: { ids: contentOnlyResourceIds },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const doc of resMget.body.docs as any[]) {
          if (!doc.found) continue
          const mr = contentByResource.get(doc._id)
          if (mr) {
            mr.name = doc._source.name
            mr.description = doc._source.description
            mr.format = doc._source.format
          }
        }
      } catch {
        // Best-effort: display without metadata
      }
    }

    const _mc1 = Date.now()

    // Attach content-only matches to existing items
    for (const item of result.items) {
      const contentMatches = contentByPackage.get(item.id)
      if (contentMatches) {
        item.matchedResources = [...(item.matchedResources ?? []), ...contentMatches]
        contentByPackage.delete(item.id)
      }
    }

    // Fetch packages not in the main result but matched via content
    const missingPkgIds = [...contentByPackage.keys()]
    if (missingPkgIds.length > 0) {
      try {
        const mgetResponse = await this.client.mget({
          index: this.packagesIndex,
          body: { ids: missingPkgIds },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const doc of mgetResponse.body.docs as any[]) {
          if (!doc.found) continue
          const item: DatasetDoc = { ...doc._source, id: doc._id }
          item.matchedResources = contentByPackage.get(doc._id)
          ;(item as DatasetDoc & { _score?: number })._score = RESOURCE_BOOST
          result.items.push(item)
          result.total += 1
        }
      } catch {
        // Best-effort: mget for content-only packages
      }
    }
    const _mc2 = Date.now()

    // eslint-disable-next-line no-console
    console.log(
      `[mergeContent-profile] ` +
      `resMget=${_mc1 - _mc0}ms(${contentOnlyResourceIds.length}ids) ` +
      `pkgMget=${_mc2 - _mc1}ms(${missingPkgIds.length}ids)`
    )
  }

  /** Stage 2: fetch content highlights only for resources visible in the result page */
  private async fetchContentHighlights(result: SearchResult, queryText: string): Promise<void> {
    const resourceIds: string[] = []
    for (const item of result.items) {
      for (const mr of item.matchedResources ?? []) {
        if (mr.matchSource === 'content') {
          resourceIds.push(mr.id)
        }
      }
    }
    if (resourceIds.length === 0) return

    try {
      const response = await this.client.search({
        index: this.contentsIndex,
        body: {
          size: resourceIds.length,
          query: {
            bool: {
              must: { match: { extractedText: { query: queryText, operator: 'and' } } },
              filter: { terms: { resourceId: resourceIds } },
            },
          },
          collapse: {
            field: 'resourceId',
            inner_hits: {
              name: 'top_chunks',
              size: 1,
              highlight: CONTENT_HIGHLIGHT,
            },
          },
        },
      })

      const snippetsByResource = new Map<string, string[]>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const hit of (response.body.hits.hits ?? []) as any[]) {
        const resourceId = hit._source.resourceId as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inner = (hit.inner_hits?.top_chunks?.hits?.hits ?? []) as any[]
        const fragment = inner[0]?.highlight?.extractedText?.[0] as string | undefined
        if (fragment) {
          snippetsByResource.set(resourceId, [sanitizeHighlight(fragment)])
        }
      }

      for (const item of result.items) {
        for (const mr of item.matchedResources ?? []) {
          const snippets = snippetsByResource.get(mr.id)
          if (snippets) mr.contentSnippets = snippets
        }
      }
    } catch {
      // Best-effort: search works without highlights
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
        index: [this.packagesIndex, this.resourcesIndex, this.contentsIndex],
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
          { index: this.contentsIndex },
          {
            size: 5,
            sort: [{ _doc: { order: 'desc' } }],
            _source: ['contentType', 'contentOriginalSize'],
          },
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
    const [pkgRecent, resRecent, contRecent] = recentResponse.body.responses as any[]

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contRecentDocs = (contRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: h._source.contentType as string | undefined,
    }))

    return {
      packages: { ...parseCatEntry(this.packagesIndex), recentDocs: pkgRecentDocs },
      resources: { ...parseCatEntry(this.resourcesIndex), recentDocs: resRecentDocs },
      contents: { ...parseCatEntry(this.contentsIndex), recentDocs: contRecentDocs },
    }
  }

  private resolveIndex(index: 'packages' | 'resources' | 'contents'): string {
    if (index === 'packages') return this.packagesIndex
    if (index === 'resources') return this.resourcesIndex
    return this.contentsIndex
  }

  async getDocument(
    index: 'packages' | 'resources' | 'contents',
    id: string
  ): Promise<Record<string, unknown> | null> {
    await this.ensureIndex()
    try {
      const response = await this.client.get({ index: this.resolveIndex(index), id })
      return response.body._source as Record<string, unknown>
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  async browseDocuments(
    index: 'packages' | 'resources' | 'contents',
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
      ...(index === 'contents' && { _source: { excludes: ['extractedText'] } }),
    }

    const searchFields: Record<string, string[]> = {
      packages: ['title', 'name', 'notes'],
      resources: ['name', 'description'],
      contents: ['extractedText'],
    }

    if (options.q?.trim()) {
      body.query = {
        multi_match: {
          query: options.q,
          fields: searchFields[index],
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

  async getContentChunks(
    resourceId: string
  ): Promise<Array<{ id: string; chunkIndex: number; chunkSize: number }>> {
    await this.ensureIndex()

    const response = await this.client.search({
      index: this.contentsIndex,
      body: {
        size: 100,
        query: { term: { resourceId } },
        _source: ['chunkIndex', 'chunkSize'],
        sort: [{ chunkIndex: { order: 'asc' } }],
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (response.body.hits.hits ?? []).map((hit: any) => ({
      id: hit._id as string,
      chunkIndex: (hit._source.chunkIndex as number) ?? 0,
      chunkSize: (hit._source.chunkSize as number) ?? 0,
    }))
  }

  async browseContentsByResource(options: {
    q?: string
    offset?: number
    limit?: number
  }): Promise<ContentBrowseResult> {
    await this.ensureIndex()

    const offset = options.offset ?? 0
    const limit = Math.min(options.limit ?? 20, 100)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = options.q?.trim()
      ? { match: { extractedText: { query: options.q, operator: 'and' } } }
      : { match_all: {} }

    const response = await this.client.search({
      index: this.contentsIndex,
      body: {
        size: 0,
        query,
        aggs: {
          by_resource: {
            terms: {
              field: 'resourceId',
              size: 10000,
              order: { _key: 'asc' as const },
            },
            aggs: {
              sample: { top_hits: { size: 1, _source: ['packageId', 'contentType'] } },
              total_size: { sum: { field: 'chunkSize' } },
            },
          },
        },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggs = response.body.aggregations as Record<string, any> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buckets = (aggs?.by_resource?.buckets ?? []) as any[]
    const total = buckets.length

    const paginated = buckets.slice(offset, offset + limit)
    const items: ContentBrowseItem[] = paginated.map((bucket) => {
      const hit = bucket.sample.hits.hits[0]?._source ?? {}
      return {
        resourceId: bucket.key as string,
        packageId: hit.packageId ?? '',
        contentType: hit.contentType ?? '',
        chunks: bucket.doc_count as number,
        totalSize: bucket.total_size.value as number,
      }
    })

    // Fetch resource names from kukan-resources
    const resourceIds = items.map((item) => item.resourceId)
    if (resourceIds.length > 0) {
      try {
        const itemLookup = new Map(items.map((item) => [item.resourceId, item]))
        const resMget = await this.client.mget({
          index: this.resourcesIndex,
          body: { ids: resourceIds },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const doc of resMget.body.docs as any[]) {
          if (!doc.found) continue
          const item = itemLookup.get(doc._id)
          if (item) {
            item.resourceName = doc._source.name ?? undefined
            item.resourceFormat = doc._source.format ?? undefined
          }
        }
      } catch {
        // Best-effort
      }
    }

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
