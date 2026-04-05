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

// Mock GeoJsonPreview to avoid Leaflet dependency in tests
vi.mock('../geojson-preview', () => ({
  GeoJsonPreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="geojson-preview">GeoJSON preview for {resourceId}</div>
  ),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

beforeEach(() => {
  mockClientFetch.mockReset()
})

describe('ResourcePreview', () => {
  describe('CSV preview', () => {
    it('should show ParquetPreview for CSV format', () => {
      render(<ResourcePreview resourceId="r1" format="CSV" />)
      expect(screen.getByTestId('parquet-preview')).toBeInTheDocument()
    })

    it('should show ParquetPreview for TSV format', () => {
      render(<ResourcePreview resourceId="r1" format="TSV" />)
      expect(screen.getByTestId('parquet-preview')).toBeInTheDocument()
    })
  })

  describe('Text format preview', () => {
    it('should show raw text preview for JSON format', async () => {
      mockClientFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Detected-Encoding': 'UTF8',
        }),
        arrayBuffer: async () => new TextEncoder().encode('{"key":"value"}').buffer,
      } as Response)

      render(<ResourcePreview resourceId="r1" format="JSON" />)

      await waitFor(() => {
        expect(screen.getByText('{"key":"value"}')).toBeInTheDocument()
      })
    })

    it('should show raw text preview for XML format', async () => {
      mockClientFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Detected-Encoding': 'UTF8',
        }),
        arrayBuffer: async () => new TextEncoder().encode('<root/>').buffer,
      } as Response)

      render(<ResourcePreview resourceId="r1" format="XML" />)

      await waitFor(() => {
        expect(screen.getByText('<root/>')).toBeInTheDocument()
      })
    })

    it('should route GeoJSON to GeoJsonPreview component', () => {
      render(<ResourcePreview resourceId="r1" format="GeoJSON" />)
      expect(screen.getByTestId('geojson-preview')).toBeInTheDocument()
    })

    it('should show not-available for unsupported formats like RDF', () => {
      render(<ResourcePreview resourceId="r1" format="RDF" />)
      expect(screen.getByText('Preview is not available for this format')).toBeInTheDocument()
    })
  })

  describe('PDF preview', () => {
    it('should render iframe with /preview endpoint for PDF format', async () => {
      mockClientFetch.mockResolvedValueOnce({ ok: true } as Response)
      render(<ResourcePreview resourceId="r1" format="PDF" />)

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).not.toBeNull()
        expect(iframe!.getAttribute('src')).toBe('/api/v1/resources/r1/preview')
      })
    })
  })

  describe('Office Online preview', () => {
    it('should show local-unavailable for uploaded XLSX on localhost', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" />)
      expect(
        screen.getByText(
          'Office preview is not available in local environments. Download the file to view it.'
        )
      ).toBeInTheDocument()
    })

    it('should show local-unavailable for uploaded DOCX on localhost', () => {
      render(<ResourcePreview resourceId="r1" format="DOCX" />)
      expect(
        screen.getByText(
          'Office preview is not available in local environments. Download the file to view it.'
        )
      ).toBeInTheDocument()
    })

    it('should render Office Online iframe when external URL is provided', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" url="https://example.com/data.xlsx" />)
      const iframe = document.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe!.getAttribute('src')).toContain('view.officeapps.live.com')
      expect(iframe!.getAttribute('src')).toContain(
        encodeURIComponent('https://example.com/data.xlsx')
      )
    })

    it('should render Office Online iframe for DOC with external URL', () => {
      render(<ResourcePreview resourceId="r1" format="DOC" url="https://example.com/report.doc" />)
      const iframe = document.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe!.getAttribute('src')).toContain('view.officeapps.live.com')
    })

    it('should route XLS to Office Online preview (not generic not-available)', () => {
      render(<ResourcePreview resourceId="r1" format="XLS" />)
      expect(screen.queryByText('Preview is not available for this format')).not.toBeInTheDocument()
    })
  })
})
