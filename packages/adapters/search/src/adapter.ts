/**
 * KUKAN Search Adapter Interface
 * Pluggable search backend (OpenSearch or PostgreSQL)
 */

import { SearchQuery, SearchResult, DatasetDoc } from '@kukan/shared'

export interface SearchAdapter {
  /**
   * Index a dataset document
   */
  index(doc: DatasetDoc): Promise<void>

  /**
   * Search for datasets
   */
  search(query: SearchQuery): Promise<SearchResult>

  /**
   * Delete a dataset from the index
   */
  delete(id: string): Promise<void>

  /**
   * Bulk index multiple documents
   */
  bulkIndex(docs: DatasetDoc[]): Promise<void>
}
