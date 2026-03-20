import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useParquetPreview } from '../use-parquet-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Mock hyparquet
const mockAsyncBufferFromUrl = vi.fn()
const mockParquetMetadataAsync = vi.fn()
const mockParquetReadObjects = vi.fn()

vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: (...args: unknown[]) => mockAsyncBufferFromUrl(...args),
  parquetMetadataAsync: (...args: unknown[]) => mockParquetMetadataAsync(...args),
  parquetReadObjects: (...args: unknown[]) => mockParquetReadObjects(...args),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('useParquetPreview', () => {
  const fakeFile = { byteLength: 1000, slice: vi.fn() }
  const fakeMetadata = {
    num_rows: 250n,
    schema: [{ name: 'root', num_children: 2 }, { name: 'col_a' }, { name: 'col_b' }],
  }

  beforeEach(() => {
    mockClientFetch.mockReset()
    mockAsyncBufferFromUrl.mockReset()
    mockParquetMetadataAsync.mockReset()
    mockParquetReadObjects.mockReset()
  })

  it('should load metadata and first page', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ url: 'https://minio/preview.parquet' }))
    mockAsyncBufferFromUrl.mockResolvedValue(fakeFile)
    mockParquetMetadataAsync.mockResolvedValue(fakeMetadata)
    mockParquetReadObjects.mockResolvedValue([{ col_a: 'val1', col_b: 'val2' }])

    const { result } = renderHook(() => useParquetPreview({ resourceId: 'r1', pageSize: 100 }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.metadata).toEqual({
      numRows: 250,
      columns: ['col_a', 'col_b'],
    })
    expect(result.current.rows).toEqual([{ col_a: 'val1', col_b: 'val2' }])
    expect(result.current.page).toBe(0)
    expect(result.current.totalPages).toBe(3) // 250 / 100 = 3
  })

  it('should handle no preview URL', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ url: null }))

    const { result } = renderHook(() => useParquetPreview({ resourceId: 'r1' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.metadata).toBeNull()
    expect(result.current.rows).toEqual([])
  })

  it('should handle preview-url fetch error', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}, false))

    const { result } = renderHook(() => useParquetPreview({ resourceId: 'r1' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Failed to get preview URL')
  })

  it('should navigate to a different page via goToPage', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ url: 'https://minio/preview.parquet' }))
    mockAsyncBufferFromUrl.mockResolvedValue(fakeFile)
    mockParquetMetadataAsync.mockResolvedValue(fakeMetadata)

    let callCount = 0
    mockParquetReadObjects.mockImplementation(
      async ({ rowStart, rowEnd }: { rowStart: number; rowEnd: number }) => {
        callCount++
        if (callCount === 1) {
          return [{ col_a: 'page0' }]
        }
        return [{ col_a: `page1-${rowStart}-${rowEnd}` }]
      }
    )

    const { result } = renderHook(() => useParquetPreview({ resourceId: 'r1', pageSize: 100 }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      result.current.goToPage(1)
    })

    await waitFor(() => {
      expect(result.current.page).toBe(1)
    })

    expect(result.current.rows[0]).toEqual({ col_a: 'page1-100-200' })
  })

  it('should clamp page numbers', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ url: 'https://minio/preview.parquet' }))
    mockAsyncBufferFromUrl.mockResolvedValue(fakeFile)
    mockParquetMetadataAsync.mockResolvedValue({
      ...fakeMetadata,
      num_rows: 50n,
    })
    mockParquetReadObjects.mockResolvedValue([{ col_a: 'val' }])

    const { result } = renderHook(() => useParquetPreview({ resourceId: 'r1', pageSize: 100 }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // totalPages should be 1
    expect(result.current.totalPages).toBe(1)

    // Going to page 5 should be clamped to page 0 (same as current)
    await act(async () => {
      result.current.goToPage(5)
    })

    expect(result.current.page).toBe(0)
  })
})
