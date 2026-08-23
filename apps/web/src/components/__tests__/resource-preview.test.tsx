import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ResourcePreview, PreviewSkeleton } from '../resource-preview'

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

// The explorer pulls in DuckDB-WASM; the analysis mode is only ever asserted
// here by which of the two is on screen.
vi.mock('../data-explorer/data-explorer', () => ({
  DataExplorer: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="data-explorer">Explorer for {resourceId}</div>
  ),
}))

// Mock JsonPreview to avoid fetch dependency in tests
vi.mock('../json-preview', () => ({
  JsonPreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="json-preview">JSON preview for {resourceId}</div>
  ),
  highlightJson: () => [],
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

beforeEach(() => {
  mockClientFetch.mockReset()
  // The analysis-mode switch is stored per session, so a test that turns it on
  // leaves every test after it rendering the explorer instead of the table.
  sessionStorage.clear()
})

/** What `GET /resources/:id/schema` answers, for the dropped-rows note. */
function schemaResponse(droppedRows?: number, droppedLines?: number[]) {
  mockClientFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ schema: { columns: [], rowCount: 2, droppedRows, droppedLines } }),
  } as Response)
}

describe('dropped rows note', () => {
  it('says how many lines the table does not hold, and where they are', async () => {
    // The reader refuses lines that do not split into these columns, which is
    // what stops one of them costing the file every column. Unsaid, a
    // reader comparing this against the download has nothing to explain it.
    schemaResponse(2, [3, 291])
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    await waitFor(() =>
      expect(screen.getByText(/not in the table: 2 \(at line 3, 291\)/)).toBeInTheDocument()
    )
  })

  it('says the list is partial when more lines were refused than it names', async () => {
    schemaResponse(40, [3, 4, 5])
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    await waitFor(() =>
      expect(screen.getByText(/: 40 \(at line 3, 4, 5 and more\)/)).toBeInTheDocument()
    )
  })

  it('shows the count alone when the schema carries no line numbers', async () => {
    // The two fields are separately optional, so a schema with the count and no
    // sample is valid — and rendering the list message with an empty list reads
    // "(at line  and more)".
    schemaResponse(2)
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    await waitFor(() => expect(screen.getByText(/not in the table: 2$/)).toBeInTheDocument())
  })

  it('says nothing where the table holds every line', async () => {
    schemaResponse(undefined)
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    expect(screen.queryByText(/not in the table/)).not.toBeInTheDocument()
  })

  it('still shows the preview when the schema cannot be read', async () => {
    // A note about what is missing is not worth losing the preview over.
    mockClientFetch.mockRejectedValue(new Error('nope'))
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    expect(await screen.findByTestId('parquet-preview')).toBeInTheDocument()
    expect(screen.queryByText(/not in the table/)).not.toBeInTheDocument()
  })

  it('says it in the analysis mode too, where the rows are counted', async () => {
    // The explorer queries the same Parquet, so a `count(*)` there returns the
    // short number — and that is the view where someone is doing arithmetic on
    // it. The note sits outside the switch for that reason.
    schemaResponse(1, [291])
    render(<ResourcePreview resourceId="r1" format="CSV" />)

    await screen.findByTestId('parquet-preview')
    fireEvent.click(screen.getByRole('switch'))

    expect(await screen.findByTestId('data-explorer')).toBeInTheDocument()
    expect(screen.getByText(/291/)).toBeInTheDocument()
  })
})

describe('PreviewSkeleton', () => {
  it('announces the loading state as a status region', () => {
    render(<PreviewSkeleton />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
  })
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
    it('should route JSON to JsonPreview component', () => {
      render(<ResourcePreview resourceId="r1" format="JSON" />)
      expect(screen.getByTestId('json-preview')).toBeInTheDocument()
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
