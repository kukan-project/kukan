import { useEffect, useState, useCallback, useRef } from 'react'
import { clientFetch } from '@/lib/client-api'
import type { AsyncBuffer } from 'hyparquet'

interface ParquetMetadata {
  numRows: number
  columns: string[]
}

interface UseParquetPreviewOptions {
  resourceId: string
  pageSize?: number
}

interface UseParquetPreviewResult {
  metadata: ParquetMetadata | null
  rows: Record<string, unknown>[]
  page: number
  totalPages: number
  loading: boolean
  pageLoading: boolean
  error: string | null
  goToPage: (page: number) => void
}

/**
 * Reads Parquet preview data from a presigned URL using hyparquet.
 * Supports pagination via Range Read (row groups).
 */
export function useParquetPreview({
  resourceId,
  pageSize = 100,
}: UseParquetPreviewOptions): UseParquetPreviewResult {
  const [metadata, setMetadata] = useState<ParquetMetadata | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pageLoading, setPageLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Cache the AsyncBuffer for reuse across page loads
  const fileRef = useRef<AsyncBuffer | null>(null)

  const totalPages = metadata ? Math.max(1, Math.ceil(metadata.numRows / pageSize)) : 0

  // Fetch presigned URL and initial metadata
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        setLoading(true)
        setError(null)

        // Get presigned URL
        const res = await clientFetch(`/api/v1/resources/${resourceId}/preview-url`)
        if (!res.ok) throw new Error('Failed to get preview URL')
        const { url } = await res.json()
        if (!url) {
          setLoading(false)
          return
        }

        // Dynamically import hyparquet
        const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } =
          await import('hyparquet')

        const file = await asyncBufferFromUrl({ url })
        fileRef.current = file

        const meta = await parquetMetadataAsync(file)
        if (cancelled) return

        const numRows = Number(meta.num_rows)
        // Leaf schema elements (no children) are the actual columns
        const columns = meta.schema.filter((s) => !s.num_children).map((s) => s.name)

        setMetadata({ numRows, columns })

        // Load first page
        const pageRows = await parquetReadObjects({
          file,
          rowStart: 0,
          rowEnd: Math.min(pageSize, numRows),
        })

        if (!cancelled) {
          setRows(pageRows)
          setPage(0)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load preview')
          setLoading(false)
        }
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [resourceId, pageSize])

  const goToPage = useCallback(
    async (newPage: number) => {
      if (!metadata || !fileRef.current) return

      const clampedPage = Math.max(0, Math.min(newPage, totalPages - 1))
      if (clampedPage === page && rows.length > 0) return

      try {
        setPageLoading(true)
        const { parquetReadObjects } = await import('hyparquet')

        const rowStart = clampedPage * pageSize
        const rowEnd = Math.min(rowStart + pageSize, metadata.numRows)
        const pageRows = await parquetReadObjects({
          file: fileRef.current!,
          rowStart,
          rowEnd,
        })

        setRows(pageRows)
        setPage(clampedPage)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load page')
      } finally {
        setPageLoading(false)
      }
    },
    [metadata, page, rows.length, pageSize, totalPages]
  )

  return {
    metadata,
    rows,
    page,
    totalPages,
    loading,
    pageLoading,
    error,
    goToPage,
  }
}
