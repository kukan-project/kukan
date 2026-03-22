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
    const controller = new AbortController()

    async function load() {
      try {
        const res = await clientFetch(path, { signal: controller.signal })
        if (!res.ok) throw new Error()
        const json = await res.json()
        if (!controller.signal.aborted) setData(json)
      } catch (e) {
        if (!controller.signal.aborted) {
          if (e instanceof DOMException && e.name === 'AbortError') return
          setError(true)
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    load()
    return () => {
      controller.abort()
    }
  }, [path])

  return { data, loading, error }
}
