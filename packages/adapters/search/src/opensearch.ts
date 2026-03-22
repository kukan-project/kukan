/**
 * KUKAN OpenSearch Adapter
 * Full-text search with kuromoji analyzer for Japanese text
 */

import { Client } from '@opensearch-project/opensearch'
import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
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

  async search(query: SearchQuery): Promise<SearchResult> {
    await this.ensureIndex()

    const offset = query.offset ?? 0
    const limit = query.limit ?? 20

    // Build bool query
    const must: Record<string, unknown>[] = []
    const filter: Record<string, unknown>[] = []

    // Full-text search (dataset-level + nested resource-level)
    if (query.q && query.q.trim()) {
      must.push({
        bool: {
          should: [
            {
              multi_match: {
                query: query.q,
                fields: ['title^3', 'name^2', 'notes', 'tags'],
                type: 'cross_fields',
                operator: 'and',
              },
            },
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

    // Name prefix filter (keyword field)
    if (query.filters?.name) {
      filter.push({ prefix: { name: query.filters.name } })
    }

    // Organization filter (no scoring impact, per ADR-013)
    if (query.filters?.organizations?.length) {
      filter.push({ terms: { organization: query.filters.organizations } })
    }

    // Tags filter (AND — each selected tag must be present)
    if (query.filters?.tags?.length) {
      for (const tag of query.filters.tags) {
        filter.push({ term: { tags: tag } })
      }
    }

    // Formats filter (AND — each selected format must be present)
    if (query.filters?.formats?.length) {
      for (const fmt of query.filters.formats) {
        filter.push({ term: { formats: fmt.toUpperCase() } })
      }
    }

    // License filter (OR — a package has one license, AND would always be empty for 2+)
    if (query.filters?.licenses?.length) {
      filter.push({ terms: { license_id: query.filters.licenses } })
    }

    // Groups filter (AND — each selected group must be present)
    if (query.filters?.groups?.length) {
      for (const group of query.filters.groups) {
        filter.push({ term: { groups: group } })
      }
    }

    // Visibility: exclude private unless in allowed orgs
    if (query.filters?.excludePrivate) {
      if (query.filters.allowPrivateOrgIds?.length) {
        filter.push({
          bool: {
            should: [
              { term: { private: false } },
              { terms: { owner_org_id: query.filters.allowPrivateOrgIds } },
            ],
            minimum_should_match: 1,
          },
        })
      } else {
        filter.push({ term: { private: false } })
      }
    }

    // my_org filter
    if (query.filters?.ownerOrgIds?.length) {
      filter.push({ terms: { owner_org_id: query.filters.ownerOrgIds } })
    }

    // Explicit private filter
    if (query.filters?.isPrivate !== undefined) {
      filter.push({ term: { private: query.filters.isPrivate } })
    }

    // Creator filter
    if (query.filters?.creatorUserId) {
      filter.push({ term: { creator_user_id: query.filters.creatorUserId } })
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
        sort: query.q?.trim()
          ? ['_score', { updated: { order: 'desc' as const } }]
          : [{ updated: { order: 'desc' as const } }],
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
}
