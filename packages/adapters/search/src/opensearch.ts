/**
 * KUKAN OpenSearch Adapter
 * Full-text search with kuromoji analyzer for Japanese text
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
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE } from './adapter'

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
  private indexName: string
  private initialized = false

  constructor(config: OpenSearchConfig) {
    this.client = new Client({
      node: config.endpoint,
      ...(config.auth && {
        auth: { username: config.auth.username, password: config.auth.password },
      }),
    })
    this.indexName = `${config.indexPrefix || 'kukan'}-packages`
  }

  /** Ensure index exists with kuromoji mapping. Idempotent. */
  async ensureIndex(): Promise<void> {
    if (this.initialized) return

    const exists = await this.client.indices.exists({ index: this.indexName })
    if (!exists.body) {
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: {
            analysis: {
              analyzer: {
                kuromoji_analyzer: {
                  type: 'custom',
                  tokenizer: 'kuromoji_tokenizer',
                  filter: ['kuromoji_baseform', 'kuromoji_part_of_speech', 'lowercase'],
                },
              },
            },
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
              resources: {
                type: 'nested',
                properties: {
                  id: { type: 'keyword' },
                  name: {
                    type: 'text',
                    analyzer: 'kuromoji_analyzer',
                    fields: { keyword: { type: 'keyword' } },
                  },
                  description: { type: 'text', analyzer: 'kuromoji_analyzer' },
                  format: { type: 'keyword' },
                },
              },
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

    this.initialized = true
  }

  async index(doc: DatasetDoc): Promise<void> {
    await this.ensureIndex()
    await this.client.index({
      index: this.indexName,
      id: doc.id,
      body: doc,
      refresh: 'wait_for',
    })
  }

  /** Build OpenSearch sort clause from query */
  private buildSort(query: SearchQuery): (string | Record<string, unknown>)[] {
    if (query.sortBy) {
      const order = query.sortOrder ?? 'desc'
      return [{ [query.sortBy]: { order } }]
    }
    // Default: relevance (_score) + updated DESC when searching, updated DESC when browsing
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

    // Build bool query
    const must: Record<string, unknown>[] = []
    const filter = this.buildFilterClauses(query.filters)

    // Full-text search (dataset-level + nested resource-level)
    if (query.q && query.q.trim()) {
      must.push({
        bool: {
          should: [
            this.buildPackageMultiMatch(query.q),
            {
              nested: {
                path: 'resources',
                query: {
                  multi_match: {
                    query: query.q,
                    fields: ['resources.name^2', 'resources.description'],
                    type: 'cross_fields',
                    operator: 'and',
                  },
                },
                inner_hits: { size: MAX_MATCHED_RESOURCES_PER_PACKAGE },
              },
            },
          ],
          minimum_should_match: 1,
        },
      })
    } else {
      must.push({ match_all: {} })
    }

    // Build aggregations when facets are requested
    const aggs = query.facets
      ? {
          organizations: { terms: { field: 'organization', size: 200 } },
          tags: { terms: { field: 'tags', size: 200 } },
          formats: { terms: { field: 'formats', size: 200 } },
          licenses: { terms: { field: 'license_id', size: 200 } },
          groups: { terms: { field: 'groups', size: 200 } },
        }
      : undefined

    const searchParams = {
      index: this.indexName,
      body: {
        from: offset,
        size: limit,
        query: {
          bool: {
            must,
            ...(filter.length > 0 && { filter }),
          },
        },
        sort: this.buildSort(query),
        ...(aggs && { aggs }),
      },
    }

    const response = await this.client.search(searchParams)

    const hits = response.body.hits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: DatasetDoc[] = (hits?.hits ?? []).map((hit: any) => {
      const doc: DatasetDoc = {
        ...hit._source,
        id: hit._id,
      }

      // Extract matched resources from nested inner_hits
      const innerHits = hit.inner_hits?.resources?.hits?.hits
      if (innerHits && innerHits.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.matchedResources = innerHits.map((ih: any) => ({
          id: ih._source.id,
          name: ih._source.name,
          description: ih._source.description,
          format: ih._source.format,
        }))
      }

      // Remove resources array from search results (it's for indexing, not display)
      delete doc.resources

      return doc
    })

    const total = hits?.total
    const totalCount = typeof total === 'number' ? total : (total?.value ?? 0)

    // Parse aggregation results into SearchFacets
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

  async delete(id: string): Promise<void> {
    await this.ensureIndex()
    try {
      await this.client.delete({
        index: this.indexName,
        id,
        refresh: 'wait_for',
      })
    } catch (err: unknown) {
      // Ignore 404 (document not found)
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404) return
      throw err
    }
  }

  async deleteAll(): Promise<void> {
    await this.ensureIndex()
    await this.client.deleteByQuery({
      index: this.indexName,
      body: { query: { match_all: {} } },
      refresh: true,
    })
  }

  async bulkIndex(docs: DatasetDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [{ index: { _index: this.indexName, _id: doc.id } }, doc])

    const response = await this.client.bulk({ body, refresh: 'wait_for' })
    if (response.body.errors) {
      const failed = response.body.items.filter(
        (item: { index?: { error?: unknown } }) => item.index?.error
      )
      throw new Error(`Bulk indexing failed for ${failed.length} documents`)
    }
  }

  async sumResourceCount(query?: ResourceCountQuery): Promise<number> {
    await this.ensureIndex()

    const must: Record<string, unknown>[] = []
    const filter = this.buildFilterClauses(query?.filters)

    if (query?.q?.trim()) {
      must.push(this.buildPackageMultiMatch(query.q))
    } else {
      must.push({ match_all: {} })
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: {
          bool: {
            must,
            ...(filter.length > 0 && { filter }),
          },
        },
        aggs: {
          resource_count: {
            nested: { path: 'resources' },
            aggs: {
              total: { value_count: { field: 'resources.id' } },
            },
          },
        },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggs = response.body.aggregations as Record<string, any> | undefined
    return (aggs?.resource_count?.total?.value as number) ?? 0
  }
}
