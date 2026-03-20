import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ResourcePreview } from '../resource-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
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
  describe('format routing', () => {
    it('should show not-available for unsupported format', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" />)
      expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
    })

    it('should show not-available when format is null', () => {
      render(<ResourcePreview resourceId="r1" format={null} />)
      expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
    })

    it('should show not-available when format is undefined', () => {
      render(<ResourcePreview resourceId="r1" />)
      expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
    })
  })

  describe('CSV preview', () => {
    const csvData = {
      headers: ['Name', 'Age'],
      rows: [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
      totalRows: 2,
      truncated: false,
      format: 'CSV',
      encoding: 'UTF8',
    }

    it('should render CSV table for CSV format', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText('Name')).toBeInTheDocument()
      })
      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('Bob')).toBeInTheDocument()
    })

    it('should render CSV table for TSV format', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="r1" format="TSV" />)

      await waitFor(() => {
        expect(screen.getByText('Name')).toBeInTheDocument()
      })
    })

    it('should be case-insensitive for format', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="r1" format="csv" />)

      await waitFor(() => {
        expect(screen.getByText('Name')).toBeInTheDocument()
      })
    })

    it('should show row count', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText(/2 of 2 rows/)).toBeInTheDocument()
      })
    })

    it('should show truncated note when data is truncated', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ ...csvData, totalRows: 1000, truncated: true })
      )
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText(/truncated/)).toBeInTheDocument()
      })
    })

    it('should show encoding', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText('Encoding: UTF8')).toBeInTheDocument()
      })
    })

    it('should show error on fetch failure', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse({ detail: 'error' }, false))
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText('Failed to load preview')).toBeInTheDocument()
      })
    })

    it('should show empty state when no data', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({
          headers: [],
          rows: [],
          totalRows: 0,
          truncated: false,
          format: 'CSV',
          encoding: 'UTF8',
        })
      )
      render(<ResourcePreview resourceId="r1" format="CSV" />)

      await waitFor(() => {
        expect(screen.getByText('No data to preview')).toBeInTheDocument()
      })
    })

    it('should call correct API endpoint', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse(csvData))
      render(<ResourcePreview resourceId="abc-123" format="CSV" />)

      await waitFor(() => {
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/abc-123/preview')
      })
    })
  })

  describe('PDF preview', () => {
    it('should render iframe for PDF format', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ url: 'https://storage.example.com/test.pdf' })
      )
      render(<ResourcePreview resourceId="r1" format="PDF" />)

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).not.toBeNull()
        expect(iframe!.src).toBe('https://storage.example.com/test.pdf')
      })
    })

    it('should be case-insensitive for pdf format', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ url: 'https://storage.example.com/test.pdf' })
      )
      render(<ResourcePreview resourceId="r1" format="pdf" />)

      await waitFor(() => {
        expect(document.querySelector('iframe')).not.toBeNull()
      })
    })

    it('should call download-url endpoint', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ url: 'https://storage.example.com/test.pdf' })
      )
      render(<ResourcePreview resourceId="abc-123" format="PDF" />)

      await waitFor(() => {
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/abc-123/download-url')
      })
    })

    it('should show error when download-url fails', async () => {
      mockClientFetch.mockResolvedValue(jsonResponse({}, false))
      render(<ResourcePreview resourceId="r1" format="PDF" />)

      await waitFor(() => {
        expect(screen.getByText('Failed to load preview')).toBeInTheDocument()
      })
    })
  })
})
