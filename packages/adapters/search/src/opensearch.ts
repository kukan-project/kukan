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
import { createLogger, type Logger } from '@kukan/shared'
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

/** Sanitize OpenSearch highlight output: allow only bare <mark> and </mark> tags */
function sanitizeHighlight(html: string): string {
  return html.replace(/<mark\b[^>]*>/gi, '<mark>').replace(/<\/?(?!mark\b)[a-z][^>]*>/gi, '')
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
  /** Optional structured logger (pino). Falls back to no-op if omitted. */
  logger?: Logger
}

export class OpenSearchAdapter implements SearchAdapter {
  private client: Client
  private searchIndex: string
  private replicas: number
  private log: Logger
  private initializedAt = 0

  constructor(config: OpenSearchConfig) {
    this.client = new Client({
      node: config.endpoint,
      ...(config.auth && {
        auth: { username: config.auth.username, password: config.auth.password },
      }),
      // Reuse TCP connections instead of opening a new socket per request,
      // bounding socket count to avoid ephemeral-port exhaustion under load.
      agent: { keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 50, maxFreeSockets: 10 },
      // Reduce recovery time after transient connection failures (e.g. during deploy).
      // 'optimistic' skips ping check and sends real requests to revive dead nodes faster.
      maxRetries: 3,
      requestTimeout: 10_000,
      resurrectStrategy: 'optimistic',
    })
    const prefix = config.indexPrefix || 'kukan'
    this.searchIndex = `${prefix}-search`
    this.replicas = config.replicas ?? 0
    this.log = config.logger ?? createLogger({ name: 'opensearch', level: 'silent' })
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

  /**
   * Ensure the search index exists with kuromoji mapping and join field. Idempotent.
   * Re-checks every 60 seconds to recover from index loss (e.g. OpenSearch maintenance).
   */
  async ensureIndex(): Promise<void> {
    if (Date.now() - this.initializedAt < 60 * 1000) return
    await this.ensureSearchIndex()
    this.initializedAt = Date.now()
  }

  /**
   * Return the number of package documents in the search index.
   * Ensures index exists before checking. Returns -1 on error.
   */
  async getPackagesDocCount(): Promise<number> {
    await this.ensureIndex()
    try {
      const count = await this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'package' } } },
      })
      return count.body.count
    } catch {
      return -1
    }
  }

  /** @returns true if the index was just created (didn't exist before) */
  private async ensureSearchIndex(): Promise<boolean> {
    const exists = await this.client.indices.exists({ index: this.searchIndex })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.searchIndex,
        body: {
          settings: {
            number_of_replicas: this.replicas,
            ...OpenSearchAdapter.KUROMOJI_ANALYSIS,
          },
          mappings: {
            properties: {
              // Join field: package is parent, resource and content are children
              join_field: {
                type: 'join',
                relations: { package: ['resource', 'content'] },
              },
              // --- Package fields ---
              id: { type: 'keyword' },
              name: {
                type: 'text',
                analyzer: 'kuromoji_analyzer',
                fields: { keyword: { type: 'keyword' } },
              },
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
              // --- Resource fields ---
              packageId: { type: 'keyword' },
              description: { type: 'text', analyzer: 'kuromoji_analyzer' },
              format: { type: 'keyword' },
              // --- Content fields ---
              resourceId: { type: 'keyword' },
              extractedText: {
                type: 'text',
                analyzer: 'kuromoji_analyzer',
                index_options: 'offsets',
              },
              contentType: { type: 'keyword' },
              chunkIndex: { type: 'integer' },
              chunkSize: { type: 'integer' },
            },
          },
        },
      })
      return true
    }
    return false
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

  /** Delete all documents of a specific type (package/resource/content) */
  private async deleteByType(type: string): Promise<void> {
    await this.ensureIndex()
    try {
      await this.client.deleteByQuery({
        index: this.searchIndex,
        body: { query: { term: { join_field: type } } },
        refresh: true,
      })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
  }

  // ------------------------------------------------------------------
  // Dataset-level operations (package documents)
  // ------------------------------------------------------------------

  async indexPackage(doc: DatasetDoc): Promise<void> {
    await this.ensureIndex()
    await this.client.index({
      index: this.searchIndex,
      id: doc.id,
      body: { ...doc, join_field: 'package' },
      refresh: 'wait_for',
    })
  }

  async deletePackage(id: string): Promise<void> {
    await this.ensureIndex()
    // Delete all child documents (resources + contents) routed to this package
    try {
      await this.client.deleteByQuery({
        index: this.searchIndex,
        body: {
          query: {
            bool: {
              should: [
                { parent_id: { type: 'resource', id } },
                { parent_id: { type: 'content', id } },
              ],
              minimum_should_match: 1,
            },
          },
        },
        routing: id,
        refresh: true,
      })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
    // Then delete the package itself
    await this.deleteDoc(this.searchIndex, id)
  }

  async deleteAllPackages(): Promise<void> {
    await this.deleteByType('package')
  }

  async bulkIndexPackages(docs: DatasetDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.searchIndex, _id: doc.id } },
      { ...doc, join_field: 'package' },
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
  // Resource-level operations (child documents of package)
  // ------------------------------------------------------------------

  async indexResource(doc: ResourceDoc): Promise<void> {
    await this.ensureIndex()
    await this.client.index({
      index: this.searchIndex,
      id: doc.id,
      body: { ...doc, join_field: { name: 'resource', parent: doc.packageId } },
      routing: doc.packageId,
      refresh: 'wait_for',
    })
  }

  async deleteResource(resourceId: string): Promise<void> {
    await this.ensureIndex()
    // deleteByQuery scatters to all shards — works without explicit routing
    await this.client.deleteByQuery({
      index: this.searchIndex,
      body: {
        query: {
          bool: {
            filter: [{ term: { _id: resourceId } }, { term: { join_field: 'resource' } }],
          },
        },
      },
      refresh: true,
    })
  }

  async deleteAllResources(): Promise<void> {
    await this.deleteByType('resource')
  }

  async bulkIndexResources(docs: ResourceDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.searchIndex, _id: doc.id, routing: doc.packageId } },
      { ...doc, join_field: { name: 'resource', parent: doc.packageId } },
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
  // Content-level operations (child documents of package)
  // ------------------------------------------------------------------

  async indexContent(doc: ContentDoc): Promise<void> {
    await this.ensureIndex()
    const docId = `${doc.resourceId}_chunk_${doc.chunkIndex}`
    await this.client.index({
      index: this.searchIndex,
      id: docId,
      body: { ...doc, join_field: { name: 'content', parent: doc.packageId } },
      routing: doc.packageId,
      refresh: 'wait_for',
    })
  }

  async deleteContent(resourceId: string): Promise<void> {
    await this.ensureIndex()
    // Delete all chunks for a resource — deleteByQuery scatters to all shards
    await this.client.deleteByQuery({
      index: this.searchIndex,
      body: {
        query: {
          bool: { filter: [{ term: { resourceId } }, { term: { join_field: 'content' } }] },
        },
      },
      refresh: true,
    })
  }

  async deleteAllContents(): Promise<void> {
    await this.deleteByType('content')
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  private static readonly VALID_SORT_FIELDS = new Set(['updated', 'created', 'name'])

  private static readonly JOIN_TYPE: Record<'packages' | 'resources' | 'contents', string> = {
    packages: 'package',
    resources: 'resource',
    contents: 'content',
  }

  /** Build OpenSearch sort clause from query */
  private buildSort(query: SearchQuery): (string | Record<string, unknown>)[] {
    if (query.sortBy && OpenSearchAdapter.VALID_SORT_FIELDS.has(query.sortBy)) {
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
      clauses.push({ prefix: { 'name.keyword': filters.name } })
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

    // Filters apply at the package (parent) level
    const filter: Record<string, unknown>[] = [{ term: { join_field: 'package' } }]
    filter.push(...this.buildFilterClauses(query.filters))

    // Build the must clause: keyword match or match_all
    const must: Record<string, unknown>[] = []
    if (hasQuery) {
      must.push({
        bool: {
          should: [
            this.buildPackageMultiMatch(query.q!),
            {
              has_child: {
                type: 'resource',
                query: {
                  multi_match: {
                    query: query.q!,
                    fields: ['name^3', 'description^2'],
                    type: 'cross_fields',
                    operator: 'and',
                  },
                },
                score_mode: 'max',
                boost: 0.4,
                inner_hits: {
                  size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
                  highlight: {
                    fields: {
                      name: {
                        number_of_fragments: 0,
                        pre_tags: ['<mark>'],
                        post_tags: ['</mark>'],
                      },
                      description: {
                        fragment_size: 200,
                        number_of_fragments: 1,
                        pre_tags: ['<mark>'],
                        post_tags: ['</mark>'],
                      },
                    },
                  },
                },
              },
            },
            {
              has_child: {
                type: 'content',
                query: {
                  match: { extractedText: { query: query.q!, operator: 'and' } },
                },
                score_mode: 'max',
                boost: 0.4,
                inner_hits: {
                  size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
                  _source: ['resourceId', 'packageId'],
                  name: 'content_hits',
                },
              },
            },
          ],
          minimum_should_match: 1,
        },
      })
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

    const highlight = hasQuery
      ? {
          fields: {
            title: { number_of_fragments: 0, pre_tags: ['<mark>'], post_tags: ['</mark>'] },
            notes: {
              fragment_size: 200,
              number_of_fragments: 1,
              pre_tags: ['<mark>'],
              post_tags: ['</mark>'],
            },
          },
        }
      : undefined

    const body = {
      from: offset,
      size: limit,
      query: { bool: { must, filter } },
      sort: this.buildSort(query),
      ...(aggs && { aggs }),
      ...(highlight && { highlight }),
    }

    const t0 = Date.now()
    const response = await this.client.search({ index: this.searchIndex, body })
    const elapsed = Date.now() - t0

    const result = this.parseSearchResponse(response, query, offset, limit)

    // For content-only matches, fetch resource metadata (name, format) via mget
    if (hasQuery) {
      await this.enrichContentMatchMetadata(result)
    }

    this.log.info({ msg: 'search', q: query.q, took: elapsed, total: result.total })

    return result
  }

  /** Parse search response with inner_hits into SearchResult */
  private parseSearchResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    query: SearchQuery,
    offset: number,
    limit: number
  ): SearchResult {
    const hits = response.body.hits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: DatasetDoc[] = (hits?.hits ?? []).map((hit: any) => {
      const { join_field: _, ...source } = hit._source
      const doc: DatasetDoc = { ...source, id: hit._id }

      // Package-level highlights
      if (hit.highlight?.title?.[0])
        doc.highlightedTitle = sanitizeHighlight(hit.highlight.title[0])
      if (hit.highlight?.notes?.[0])
        doc.highlightedNotes = sanitizeHighlight(hit.highlight.notes[0])

      // Resource metadata matches from inner_hits
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resourceInnerHits = hit.inner_hits?.resource?.hits?.hits as any[] | undefined
      if (resourceInnerHits?.length) {
        const matched: MatchedResource[] = resourceInnerHits.map((rh) => ({
          id: rh._source.id ?? rh._id,
          name: rh._source.name,
          description: rh._source.description,
          format: rh._source.format,
          matchSource: 'metadata' as const,
          ...(rh.highlight?.name?.[0] && {
            highlightedName: sanitizeHighlight(rh.highlight.name[0]),
          }),
          ...(rh.highlight?.description?.[0] && {
            highlightedDescription: sanitizeHighlight(rh.highlight.description[0]),
          }),
        }))
        doc.matchedResources = [...(doc.matchedResources ?? []), ...matched]
      }

      // Content matches from inner_hits (resourceId only, highlights loaded lazily)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentInnerHits = hit.inner_hits?.content_hits?.hits?.hits as any[] | undefined
      if (contentInnerHits?.length) {
        const existingResourceIds = new Set((doc.matchedResources ?? []).map((mr) => mr.id))
        for (const ch of contentInnerHits) {
          const resourceId = ch._source.resourceId as string
          // If already matched by metadata, upgrade to content match
          const existing = (doc.matchedResources ?? []).find((mr) => mr.id === resourceId)
          if (existing) {
            existing.matchSource = 'content'
            existing._contentDocId = ch._id as string
          } else if (!existingResourceIds.has(resourceId)) {
            existingResourceIds.add(resourceId)
            doc.matchedResources = [
              ...(doc.matchedResources ?? []),
              {
                id: resourceId,
                matchSource: 'content',
                _contentDocId: ch._id as string,
              },
            ]
          }
        }
      }

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

  /** Fetch resource metadata (name, format) for content-only matched resources via mget */
  private async enrichContentMatchMetadata(result: SearchResult): Promise<void> {
    const docsToFetch: Array<{ _id: string; routing: string }> = []
    for (const item of result.items) {
      for (const mr of item.matchedResources ?? []) {
        if (mr.matchSource === 'content' && mr.name === undefined) {
          docsToFetch.push({ _id: mr.id, routing: item.id })
        }
      }
    }
    if (docsToFetch.length === 0) return

    try {
      const resMget = await this.client.mget({
        index: this.searchIndex,
        body: { docs: docsToFetch },
      })
      const metadataMap = new Map<
        string,
        { name?: string; description?: string; format?: string }
      >()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const doc of resMget.body.docs as any[]) {
        if (!doc.found) continue
        metadataMap.set(doc._id, {
          name: doc._source.name,
          description: doc._source.description,
          format: doc._source.format,
        })
      }
      for (const item of result.items) {
        for (const mr of item.matchedResources ?? []) {
          const meta = metadataMap.get(mr.id)
          if (meta) {
            mr.name = meta.name
            mr.description = meta.description
            mr.format = meta.format
          }
        }
      }
    } catch {
      // Best-effort: display without metadata
    }
  }

  /** Fetch content highlights for specific chunk document IDs.
   *  Uses an `ids` query — no collapse, no full-text re-scan.
   *  Returns a map of chunkDocId → sanitized highlight snippet. */
  async fetchContentHighlights(
    chunkDocIds: string[],
    queryText: string,
    filters?: SearchFilters
  ): Promise<Record<string, string>> {
    if (chunkDocIds.length === 0) return {}
    await this.ensureIndex()

    try {
      const response = await this.client.search({
        index: this.searchIndex,
        body: {
          size: chunkDocIds.length,
          query: {
            bool: {
              must: { match: { extractedText: { query: queryText, operator: 'and' } } },
              filter: [
                { ids: { values: chunkDocIds } },
                { term: { join_field: 'content' } },
                // Enforce the caller's visibility: only return chunks whose parent
                // package passes the same private/owner_org filter as search().
                {
                  has_parent: {
                    parent_type: 'package',
                    query: { bool: { filter: this.buildFilterClauses(filters) } },
                  },
                },
              ],
            },
          },
          _source: false,
          highlight: CONTENT_HIGHLIGHT,
        },
      })

      const result: Record<string, string> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const hit of (response.body.hits.hits ?? []) as any[]) {
        const fragment = hit.highlight?.extractedText?.[0] as string | undefined
        if (fragment) {
          result[hit._id as string] = sanitizeHighlight(fragment)
        }
      }
      return result
    } catch {
      return {}
    }
  }

  // ------------------------------------------------------------------
  // Resource count
  // ------------------------------------------------------------------

  async sumResourceCount(query?: ResourceCountQuery): Promise<number> {
    await this.ensureIndex()

    // Count resource child documents whose parent packages match the query/filters
    const must: Record<string, unknown>[] = []
    const parentFilter = this.buildFilterClauses(query?.filters)

    if (query?.q?.trim()) {
      must.push(this.buildPackageMultiMatch(query.q))
    } else {
      must.push({ match_all: {} })
    }

    const countResponse = await this.client.count({
      index: this.searchIndex,
      body: {
        query: {
          bool: {
            filter: [
              { term: { join_field: 'resource' } },
              {
                has_parent: {
                  parent_type: 'package',
                  query: {
                    bool: { must, ...(parentFilter.length > 0 && { filter: parentFilter }) },
                  },
                },
              },
            ],
          },
        },
      },
    })

    return (countResponse.body.count as number) ?? 0
  }

  // ------------------------------------------------------------------
  // Index stats
  // ------------------------------------------------------------------

  async getIndexStats(): Promise<IndexStats> {
    await this.ensureIndex()

    // Count documents by type and get recent docs in parallel
    const [catResponse, pkgCount, resCount, contCount, recentResponse] = await Promise.all([
      this.client.cat.indices({
        index: this.searchIndex,
        format: 'json',
        h: ['index', 'docs.count', 'store.size'],
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'package' } } },
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'resource' } } },
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'content' } } },
      }),
      this.client.msearch({
        body: [
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'package' } },
            sort: [{ updated: { order: 'desc' } }],
            _source: ['name', 'title', 'updated'],
          },
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'resource' } },
            sort: [{ _doc: { order: 'desc' } }],
            _source: ['name', 'packageId'],
          },
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'content' } },
            sort: [{ _doc: { order: 'desc' } }],
            _source: ['contentType'],
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
    const row = indices.find((i) => i.index === this.searchIndex)
    const sizeBytes = parseSizeToBytes(row?.['store.size'] ?? '0b')

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
      indexName: this.searchIndex,
      totalSizeBytes: sizeBytes,
      packages: { docCount: pkgCount.body.count, recentDocs: pkgRecentDocs },
      resources: { docCount: resCount.body.count, recentDocs: resRecentDocs },
      contents: { docCount: contCount.body.count, recentDocs: contRecentDocs },
    }
  }

  async getDocument(
    index: 'packages' | 'resources' | 'contents',
    id: string
  ): Promise<Record<string, unknown> | null> {
    await this.ensureIndex()
    try {
      const response = await this.client.search({
        index: this.searchIndex,
        body: {
          size: 1,
          query: {
            bool: {
              filter: [
                { term: { _id: id } },
                { term: { join_field: OpenSearchAdapter.JOIN_TYPE[index] } },
              ],
            },
          },
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hit = (response.body.hits?.hits as any[])?.[0]
      return hit ? (hit._source as Record<string, unknown>) : null
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
    // Map plural index name to join_field type (e.g. 'packages' → 'package')
    const joinType = OpenSearchAdapter.JOIN_TYPE[index]

    const searchFields: Record<string, string[]> = {
      packages: ['title', 'name', 'notes'],
      resources: ['name', 'description'],
      contents: ['extractedText'],
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      from: offset,
      size: limit,
      sort: [{ _doc: { order: 'desc' } }],
      query: { term: { join_field: joinType } },
      ...(index === 'contents' && { _source: { excludes: ['extractedText'] } }),
    }

    if (options.q?.trim()) {
      body.query = {
        bool: {
          filter: [{ term: { join_field: joinType } }],
          must: [
            {
              multi_match: {
                query: options.q,
                fields: searchFields[index],
                type: 'cross_fields' as const,
                operator: 'and' as const,
              },
            },
          ],
        },
      }
      body.sort = ['_score', { _doc: { order: 'desc' } }]
    }

    const response = await this.client.search({ index: this.searchIndex, body })
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
      index: this.searchIndex,
      body: {
        size: 100,
        query: {
          bool: { filter: [{ term: { resourceId } }, { term: { join_field: 'content' } }] },
        },
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
    const must: any = options.q?.trim()
      ? { match: { extractedText: { query: options.q, operator: 'and' } } }
      : { match_all: {} }

    const response = await this.client.search({
      index: this.searchIndex,
      body: {
        size: 0,
        query: { bool: { must, filter: [{ term: { join_field: 'content' } }] } },
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

    // Fetch resource names from search index (resource documents, with routing)
    if (items.length > 0) {
      try {
        const itemLookup = new Map(items.map((item) => [item.resourceId, item]))
        const resMget = await this.client.mget({
          index: this.searchIndex,
          body: {
            docs: items.map((item) => ({ _id: item.resourceId, routing: item.packageId })),
          },
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
