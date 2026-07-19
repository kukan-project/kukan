import { useFetch } from './use-fetch'

interface SiteSettings {
  registrationEnabled: boolean
  semanticSearchEnabled: boolean
  /** Example-query chips managed in the admin UI; empty = hidden */
  searchExampleQueries: string[]
  /** AI metadata suggestions are available (ADR-040) */
  metadataSuggestEnabled: boolean
  /** Suggestions run on a local model — edit UIs show a quality caveat */
  metadataSuggestLocalModel: boolean
}

export function useSiteSettings() {
  const { data, loading, error } = useFetch<SiteSettings>('/api/v1/site/settings')

  return {
    registrationEnabled: error ? true : (data?.registrationEnabled ?? null),
    // null while loading; consumers should only hide UI on an explicit false
    semanticSearchEnabled: error ? true : (data?.semanticSearchEnabled ?? null),
    // null while loading/on error — consumers render nothing until known
    searchExampleQueries: data?.searchExampleQueries ?? null,
    // Conservative on error: the button triggers paid LLM calls, so hide it
    metadataSuggestEnabled: error ? false : (data?.metadataSuggestEnabled ?? null),
    metadataSuggestLocalModel: data?.metadataSuggestLocalModel ?? false,
    loading,
  }
}
