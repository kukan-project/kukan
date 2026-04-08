import { useFetch } from './use-fetch'

interface SiteSettings {
  registrationEnabled: boolean
}

export function useSiteSettings() {
  const { data, loading, error } = useFetch<SiteSettings>('/api/v1/site/settings')

  return {
    registrationEnabled: error ? true : (data?.registrationEnabled ?? null),
    loading,
  }
}
