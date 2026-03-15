'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { clientFetch } from '@/lib/client-api'

const DEFAULT_PAGE_SIZE = 20

export function usePaginatedFetch<T>(url: string, pageSize = DEFAULT_PAGE_SIZE) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const requestId = useRef(0)

  const fetchPage = useCallback(
    async (newOffset: number) => {
      const id = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const separator = url.includes('?') ? '&' : '?'
        const res = await clientFetch(`${url}${separator}limit=${pageSize}&offset=${newOffset}`)
        if (id !== requestId.current) return // stale response
        if (res.ok) {
          const data = await res.json()
          setItems(data.items)
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
          setLoading(false)
        }
      }
    },
    [url, pageSize]
  )

  useEffect(() => {
    fetchPage(0)
    return () => {
      // Invalidate in-flight requests immediately when url/pageSize changes,
      // closing the gap between re-render and the next fetchPage(0) call.
      requestId.current++
    }
  }, [fetchPage])

  const totalPages = Math.ceil(total / pageSize)
  const currentPage = Math.floor(offset / pageSize) + 1

  return { items, total, offset, loading, error, totalPages, currentPage, fetchPage, pageSize }
}
