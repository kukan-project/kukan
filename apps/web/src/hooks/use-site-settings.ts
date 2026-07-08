import { useFetch } from './use-fetch'

interface SiteSettings {
  registrationEnabled: boolean
  semanticSearchEnabled: boolean
  /** Example-query chips managed in the admin UI; empty = hidden */
  searchExampleQueries: string[]
}

export function useSiteSettings() {
  const { data, loading, error } = useFetch<SiteSettings>('/api/v1/site/settings')

  return {
    registrationEnabled: error ? true : (data?.registrationEnabled ?? null),
    // null while loading; consumers should only hide UI on an explicit false
    semanticSearchEnabled: error ? true : (data?.semanticSearchEnabled ?? null),
    // null while loading/on error — consumers render nothing until known
    searchExampleQueries: data?.searchExampleQueries ?? null,
    loading,
  }
}
