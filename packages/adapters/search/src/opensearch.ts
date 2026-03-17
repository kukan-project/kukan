/**
 * KUKAN OpenSearch Adapter
 * Full-text search with kuromoji analyzer for Japanese text
 */

import { Client } from '@opensearch-project/opensearch'
import { SearchQuery, SearchResult, DatasetDoc } from '@kukan/shared'
import { SearchAdapter } from './adapter'

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

    // Full-text search
    if (query.q && query.q.trim()) {
      must.push({
        multi_match: {
          query: query.q,
          fields: ['title^3', 'name^2', 'notes', 'tags'],
          type: 'best_fields',
        },
      })
    } else {
      must.push({ match_all: {} })
    }

    // Organization filter (no scoring impact, per ADR-013)
    if (query.filters?.organization) {
      filter.push({ term: { organization: query.filters.organization } })
    }

    // Tags filter
    if (query.filters?.tags) {
      const tagNames = query.filters.tags as string[]
      if (tagNames.length > 0) {
        filter.push({ terms: { tags: tagNames } })
      }
    }

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
      },
    }

    const response = await this.client.search(searchParams)

    const hits = response.body.hits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: DatasetDoc[] = (hits?.hits ?? []).map((hit: any) => ({
      ...hit._source,
      id: hit._id,
    }))

    const total = hits?.total
    const totalCount = typeof total === 'number' ? total : (total?.value ?? 0)

    return { items, total: totalCount, offset, limit }
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

  async bulkIndex(docs: DatasetDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.indexName, _id: doc.id } },
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
}
