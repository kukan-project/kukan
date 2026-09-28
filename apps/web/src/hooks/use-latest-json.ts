'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { clientFetch } from '@/lib/client-api'
import { keepIfEqual } from '@/lib/keep-if-equal'

/**
 * A JSON value fetched on mount and again on `fetch()`, for counts a page
 * polls. The latest request wins, so a poll that started before an action
 * cannot land after the action's reload with what came before it, and the
 * same answer keeps the same value, so nothing re-renders. Never throws: a
 * failed fetch keeps what is shown, and must not cut short whatever asked for
 * it — a dialog closing, say.
 */
export function useLatestJson<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const request = useRef(0)

  const fetch = useCallback(async () => {
    const id = ++request.current
    try {
      const res = await clientFetch(url)
      if (!res.ok) return
      const next: T = await res.json()
      if (id === request.current) setData((prev) => keepIfEqual(prev, next))
    } catch {
      // What is shown stays; the next fetch tries again
    }
  }, [url])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { data, fetch }
}
