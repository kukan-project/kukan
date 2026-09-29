import { useEffect, useRef, useState } from 'react'
import { clientFetch } from '@/lib/client-api'

interface UseFetchResult<T> {
  data: T | null
  loading: boolean
  error: boolean
}

/**
 * Simple fetch hook with cancellation support.
 * Fetches JSON from the given API path on mount.
 * A `null` path fetches nothing — for data only some callers need.
 * A change of `version` fetches the same path again — after a write it depends on
 * — and keeps what is shown until the new answer lands.
 */
export function useFetch<T>(path: string | null, version = 0): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const shownPath = useRef(path)

  useEffect(() => {
    if (shownPath.current !== path) {
      shownPath.current = path
      setData(null)
    }
    setLoading(path !== null)
    setError(false)
    if (path === null) return
    const url = path

    const controller = new AbortController()

    async function load() {
      try {
        const res = await clientFetch(url, { signal: controller.signal })
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
  }, [path, version])

  return { data, loading, error }
}
