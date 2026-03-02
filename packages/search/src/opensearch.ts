/**
 * KUKAN OpenSearch Adapter
 * AWS OpenSearch implementation (Phase 5)
 */

import { SearchQuery, SearchResult, DatasetDoc } from '@kukan/shared'
import { SearchAdapter } from './adapter'

export interface OpenSearchConfig {
  endpoint: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
}

export class OpenSearchAdapter implements SearchAdapter {
  constructor(_config: OpenSearchConfig) {
    // Stub implementation
  }

  async index(_doc: DatasetDoc): Promise<void> {
    throw new Error('OpenSearchAdapter not implemented yet (Phase 5)')
  }

  async search(_query: SearchQuery): Promise<SearchResult> {
    throw new Error('OpenSearchAdapter not implemented yet (Phase 5)')
  }

  async delete(_id: string): Promise<void> {
    throw new Error('OpenSearchAdapter not implemented yet (Phase 5)')
  }

  async bulkIndex(_docs: DatasetDoc[]): Promise<void> {
    throw new Error('OpenSearchAdapter not implemented yet (Phase 5)')
  }
}
