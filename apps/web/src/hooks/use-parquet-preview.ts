import { useEffect, useState, useCallback, useRef } from 'react'
import type { AsyncBuffer, FileMetaData } from 'hyparquet'

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
 * Reads Parquet preview data via server-proxied endpoint using hyparquet.
 * Uses /preview (same-origin proxy) instead of presigned URLs to avoid S3 CORS issues
 * with HEAD requests on GET-signed presigned URLs.
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
  /** The footer, kept so page turns do not re-read the tail of the file. */
  const metaRef = useRef<FileMetaData | null>(null)

  const totalPages = metadata ? Math.max(1, Math.ceil(metadata.numRows / pageSize)) : 0

  // Load Parquet metadata and first page via server proxy
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        setLoading(true)
        setError(null)

        // Server-proxied preview endpoint (same-origin, no CORS issues)
        const proxyUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`

        // Dynamically imported, like the reader: neither belongs in the bundle
        // of a page that never opens a preview.
        const [{ asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects }, zstd] =
          await Promise.all([import('hyparquet'), import('./parquet-codecs')])

        let file: AsyncBuffer
        try {
          file = await asyncBufferFromUrl({ url: proxyUrl })
        } catch {
          // 404 or network error — preview not available
          setLoading(false)
          return
        }
        fileRef.current = file

        const meta = await parquetMetadataAsync(file)
        metaRef.current = meta
        if (cancelled) return

        const numRows = Number(meta.num_rows)
        // Leaf schema elements (no children) are the actual columns
        const columns = meta.schema.filter((s) => !s.num_children).map((s) => s.name)

        setMetadata({ numRows, columns })

        // Load first page
        const pageRows = await parquetReadObjects({
          file,
          metadata: meta,
          compressors: zstd.compressors,
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
        const [{ parquetReadObjects }, zstd] = await Promise.all([
          import('hyparquet'),
          import('./parquet-codecs'),
        ])

        const rowStart = clampedPage * pageSize
        const rowEnd = Math.min(rowStart + pageSize, metadata.numRows)
        const pageRows = await parquetReadObjects({
          file: fileRef.current!,
          // The footer this run already read. Without it every page turn asks
          // for the tail of the file again — measured at 512 KB against 8 KB of
          // rows, so the refetch outweighs the data by 60x.
          metadata: metaRef.current!,
          compressors: zstd.compressors,
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
