'use client'

import { useEffect, useState, useCallback } from 'react'
import { clientFetch } from '@/lib/client-api'

const DEFAULT_PAGE_SIZE = 20

export function usePaginatedFetch<T>(url: string, pageSize = DEFAULT_PAGE_SIZE) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchPage = useCallback(
    async (newOffset: number) => {
      setLoading(true)
      try {
        const separator = url.includes('?') ? '&' : '?'
        const res = await clientFetch(
          `${url}${separator}limit=${pageSize}&offset=${newOffset}`
        )
        if (res.ok) {
          const data = await res.json()
          setItems(data.items)
          setTotal(data.total)
          setOffset(newOffset)
        }
      } finally {
        setLoading(false)
      }
    },
    [url, pageSize]
  )

  useEffect(() => {
    fetchPage(0)
  }, [fetchPage])

  const totalPages = Math.ceil(total / pageSize)
  const currentPage = Math.floor(offset / pageSize) + 1

  return { items, total, offset, loading, totalPages, currentPage, fetchPage, pageSize }
}
