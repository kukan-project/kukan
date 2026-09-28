'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { clientFetch } from '@/lib/client-api'
import { keepIfEqual } from '@/lib/keep-if-equal'

const DEFAULT_PAGE_SIZE = 20

export function usePaginatedFetch<T>(url: string, pageSize = DEFAULT_PAGE_SIZE) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const requestId = useRef(0)
  // `loading`, readable from a callback without making it a dependency
  const loadingRef = useRef(false)
  const refreshRequest = useRef(0)

  const pageUrl = useCallback(
    (at: number) => `${url}${url.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${at}`,
    [url, pageSize]
  )

  const fetchPage = useCallback(
    async (newOffset: number) => {
      const id = ++requestId.current
      loadingRef.current = true
      setLoading(true)
      setError(null)
      try {
        const res = await clientFetch(pageUrl(newOffset))
        if (id !== requestId.current) return // stale response
        if (res.ok) {
          const data = await res.json()
          setItems((prev) => keepIfEqual(prev, data.items))
          setTotal(data.total)
          setOffset(newOffset)
        } else {
          setError(new Error(`HTTP ${res.status}`))
        }
      } catch (e) {
        if (id !== requestId.current) return // stale error
        setError(e instanceof Error ? e : new Error('Unknown error'))
      } finally {
        if (id === requestId.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [pageUrl]
  )

  /**
   * The page shown, fetched again for polling: no `loading`, and a failure
   * keeps what is shown for the next poll to retry; a success clears an
   * earlier error. It gives way to a fetch in flight, and a fetch or refresh
   * started after it wins.
   */
  const refresh = useCallback(async () => {
    if (loadingRef.current) return
    const id = requestId.current
    const refreshId = ++refreshRequest.current
    const current = () => id === requestId.current && refreshId === refreshRequest.current
    try {
      const res = await clientFetch(pageUrl(offset))
      if (!current() || !res.ok) return
      const data = await res.json()
      if (!current()) return
      setItems((prev) => keepIfEqual(prev, data.items))
      setTotal(data.total)
      setError(null)
    } catch {
      // What is shown stays; the next poll tries again
    }
  }, [pageUrl, offset])

  useEffect(() => {
    fetchPage(0)
    return () => {
      // Invalidate in-flight requests immediately when url/pageSize changes,
      // closing the gap between re-render and the next fetchPage(0) call.
      requestId.current++
    }
  }, [fetchPage])

  // The last rows of the last page deleted, or gone from the list between
  // polls, leave that page empty; step back to the page that now ends the
  // list — the first, when none are left. Not while a fetch has failed: the
  // step back would fail the same way and go again at once, so it waits for
  // the retry button or a poll that gets through
  useEffect(() => {
    if (!loading && !error && items.length === 0 && offset > 0 && offset >= total) {
      fetchPage(Math.max(0, Math.floor((total - 1) / pageSize) * pageSize))
    }
  }, [loading, error, items.length, total, offset, pageSize, fetchPage])

  const totalPages = Math.ceil(total / pageSize)
  const currentPage = Math.floor(offset / pageSize) + 1

  return {
    items,
    total,
    offset,
    loading,
    error,
    totalPages,
    currentPage,
    fetchPage,
    refresh,
    pageSize,
  }
}
