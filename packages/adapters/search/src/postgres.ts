/**
 * KUKAN PostgreSQL Search Adapter
 * Full-text search using pg_bigm (Japanese tokenization)
 */

import { SearchQuery, SearchResult, DatasetDoc } from '@kukan/shared'
import { SearchAdapter } from './adapter'

export interface PostgresSearchConfig {
  connectionString: string
}

export class PostgresSearchAdapter implements SearchAdapter {
  constructor(_config: PostgresSearchConfig) {
    // Phase 1: Minimal implementation
    // Connection will be used in Phase 2
  }

  async index(_doc: DatasetDoc): Promise<void> {
    // Phase 1: Minimal implementation
    // Actual indexing happens via database triggers on package table
    // This is a no-op for now
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    // Phase 1: Return empty results
    // Full implementation in Phase 2 with pg_bigm setup
    return {
      items: [],
      total: 0,
      offset: query.offset ?? 0,
      limit: query.limit ?? 20,
    }
  }

  async delete(_id: string): Promise<void> {
    // Phase 1: No-op
    // Deletion handled by database cascade
  }

  async bulkIndex(_docs: DatasetDoc[]): Promise<void> {
    // Phase 1: No-op
    // Bulk indexing via database triggers
  }
}
