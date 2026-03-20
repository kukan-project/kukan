import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ResourcePreview } from '../resource-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Mock ParquetPreview to avoid hyparquet dependency in tests
vi.mock('../parquet-preview', () => ({
  ParquetPreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="parquet-preview">Parquet preview for {resourceId}</div>
  ),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return {
    ok,
    json: async () => data,
  } as Response
}

beforeEach(() => {
  mockClientFetch.mockReset()
})

describe('ResourcePreview', () => {
  describe('Parquet preview', () => {
    it('should show ParquetPreview when preview-url returns a URL', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse({ url: 'https://minio/preview.parquet' }))

      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByTestId('parquet-preview')).toBeInTheDocument()
      })
    })

    it('should show no-data when preview-url returns null for CSV', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse({ url: null }))

      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText('Preview data is not available')).toBeInTheDocument()
      })
    })

    it('should show not-available when preview-url returns null for unsupported format', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse({ url: null }))

      render(<ResourcePreview resourceId="r1" format="XLSX" />)

      await waitFor(() => {
        expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
      })
    })
  })

  describe('PDF preview', () => {
    it('should render iframe for PDF format via preview-url', async () => {
      // PDF uses preview-url which returns the original file URL with inline disposition
      mockClientFetch.mockResolvedValueOnce(
        jsonResponse({ url: 'https://storage.example.com/test.pdf' })
      )

      render(<ResourcePreview resourceId="r1" format="PDF" />)

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).not.toBeNull()
        expect(iframe!.src).toBe('https://storage.example.com/test.pdf')
      })
    })

    it('should show not-available when preview-url fails for PDF', async () => {
      mockClientFetch.mockResolvedValueOnce(jsonResponse({}, false))

      render(<ResourcePreview resourceId="r1" format="PDF" />)

      await waitFor(() => {
        expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
      })
    })
  })
})
