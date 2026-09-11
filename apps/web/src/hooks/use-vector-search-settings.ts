import { useFetch } from './use-fetch'

/** What `GET /api/v1/admin/settings/vector-search` answers (ADR-034 / ADR-036). */
export interface VectorSearchSettings {
  enabled: boolean
  model: string | null
  semanticEnabled: boolean
  baseMinSimilarity: number
  baseSource: 'env' | 'model' | 'default'
  notches: number
  step: number
  maxNotches: number
  effectiveMinSimilarity: number
}

/** The one place the admin UI learns whether embedding is configured. */
export function useVectorSearchSettings() {
  return useFetch<VectorSearchSettings>('/api/v1/admin/settings/vector-search')
}
