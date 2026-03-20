import { useEffect, useState } from 'react'
import { clientFetch } from '@/lib/client-api'

interface UseFetchResult<T> {
  data: T | null
  loading: boolean
  error: boolean
}

/**
 * Simple fetch hook with cancellation support.
 * Fetches JSON from the given API path on mount.
 */
export function useFetch<T>(path: string): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await clientFetch(path)
        if (!res.ok) throw new Error()
        const json = await res.json()
        if (!cancelled) setData(json)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [path])

  return { data, loading, error }
}
