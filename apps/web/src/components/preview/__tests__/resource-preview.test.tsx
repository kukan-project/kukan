import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubObservers } from '@/__tests__/stub-observers'
import { ResourcePreview, PreviewSkeleton } from '../resource-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Mock GeoJsonPreview to avoid Leaflet dependency in tests
vi.mock('../geojson-preview', () => ({
  GeoJsonPreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="geojson-preview">GeoJSON preview for {resourceId}</div>
  ),
}))

// The one table (ADR-048); mocked to avoid hyparquet and DuckDB-WASM in tests
vi.mock('@/components/data-explorer/data-explorer', () => ({
  DataExplorer: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="data-explorer">Explorer for {resourceId}</div>
  ),
}))

// ibisOffice runs in a sandboxed frame a browser draws; its own tests cover it
vi.mock('../ibis-office-preview', () => ({
  IbisOfficePreview: ({ resourceId, format }: { resourceId: string; format: string }) => (
    <div data-testid="ibis-office-preview">
      ibisOffice {format} {resourceId}
    </div>
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
})
afterEach(() => vi.unstubAllGlobals())

/** What the owner's `GET /resources/:id/schema` read carried down as a prop. */
function schemaWith(droppedRows?: number, droppedLines?: number[]) {
  return { columns: [], rowCount: 2, droppedRows, droppedLines }
}

describe('dropped rows note', () => {
  it('says how many lines the table does not hold, and where they are', async () => {
    // The reader refuses lines that do not split into these columns, which is
    // what stops one of them costing the file every column. Unsaid, a
    // reader comparing this against the download has nothing to explain it.
    render(<ResourcePreview resourceId="r1" format="CSV" schema={schemaWith(2, [3, 291])} />)

    await waitFor(() =>
      expect(screen.getByText(/not in the table: 2 \(at line 3, 291\)/)).toBeInTheDocument()
    )
  })

  it('says the list is partial when more lines were refused than it names', async () => {
    render(<ResourcePreview resourceId="r1" format="CSV" schema={schemaWith(40, [3, 4, 5])} />)

    await waitFor(() =>
      expect(screen.getByText(/: 40 \(at line 3, 4, 5 and more\)/)).toBeInTheDocument()
    )
  })

  it('shows the count alone when the schema carries no line numbers', async () => {
    // The two fields are separately optional, so a schema with the count and no
    // sample is valid — and rendering the list message with an empty list reads
    // "(at line  and more)".
    render(<ResourcePreview resourceId="r1" format="CSV" schema={schemaWith(2)} />)

    await waitFor(() => expect(screen.getByText(/not in the table: 2$/)).toBeInTheDocument())
  })

  it('says nothing where the table holds every line', async () => {
    render(<ResourcePreview resourceId="r1" format="CSV" schema={schemaWith(undefined)} />)

    expect(screen.queryByText(/not in the table/)).not.toBeInTheDocument()
  })

  it('still shows the preview when the schema could not be read', async () => {
    // A note about what is missing is not worth losing the preview over: the
    // owner passes null when its read failed, and the preview stands alone.
    render(<ResourcePreview resourceId="r1" format="CSV" schema={null} />)

    expect(await screen.findByTestId('data-explorer')).toBeInTheDocument()
    expect(screen.queryByText(/not in the table/)).not.toBeInTheDocument()
  })

  it('sits outside the table, wherever the rows are being counted', async () => {
    // The explorer queries the same Parquet, so a `count(*)` there returns the
    // short number — the note belongs to the table as a whole, not one view.
    render(<ResourcePreview resourceId="r1" format="CSV" schema={schemaWith(1, [291])} />)

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
    it('should show the table explorer for CSV format', () => {
      render(<ResourcePreview resourceId="r1" format="CSV" />)
      expect(screen.getByTestId('data-explorer')).toBeInTheDocument()
    })

    it('should show the table explorer for TSV format', () => {
      render(<ResourcePreview resourceId="r1" format="TSV" />)
      expect(screen.getByTestId('data-explorer')).toBeInTheDocument()
    })
  })

  describe('Text format preview', () => {
    it('shows a JSON whose records made a table as the table, the file a toggle away', () => {
      const schema = {
        columns: [{ name: 'id', type: 'string' as const, nullable: false, nullCount: 0 }],
        rowCount: 2,
      }
      render(<ResourcePreview resourceId="r-json" format="JSON" schema={schema} />)

      expect(screen.getByTestId('data-explorer')).toBeInTheDocument()
      expect(screen.getByText('JSON')).toBeInTheDocument()
      expect(screen.queryByTestId('json-preview')).not.toBeInTheDocument()
    })

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

  describe('ibisOffice preview (the default, ADR-065)', () => {
    it('draws the original of each format ibisOffice reads, beside its extracted text', () => {
      for (const format of ['XLSX', 'XLS', 'DOCX', 'PPTX', 'PPT']) {
        const { unmount } = render(<ResourcePreview resourceId="r1" format={format} />)
        expect(screen.getByText('Original')).toBeInTheDocument()
        expect(screen.getByText('Extracted text')).toBeInTheDocument()
        expect(screen.getByTestId('ibis-office-preview')).toHaveTextContent(
          `ibisOffice ${format} r1`
        )
        unmount()
      }
    })

    it('draws a non-public dataset’s file too: it never leaves the visitor’s browser', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" notPublic />)
      expect(screen.getByTestId('ibis-office-preview')).toBeInTheDocument()
    })

    it('offers only the extracted text of a DOC, which ibisOffice does not read', async () => {
      mockClientFetch.mockResolvedValue(new Response(null, { status: 404 }))
      render(<ResourcePreview resourceId="r1" format="DOC" />)
      await waitFor(() =>
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/document-text')
      )
      expect(screen.queryByText('Original')).not.toBeInTheDocument()
      expect(screen.queryByTestId('ibis-office-preview')).not.toBeInTheDocument()
    })

    it('opens on the extracted text of a file that took a tab down, the original a tab away', async () => {
      mockClientFetch.mockResolvedValue(new Response(null, { status: 404 }))
      // What a tab that died drawing version 3 of the file left behind
      localStorage.setItem('kukan:original-draw:r1:3:gone', String(Date.now() - 60_000))
      render(<ResourcePreview resourceId="r1" format="XLSX" version={3} />)

      expect(screen.getByText('Original')).toBeInTheDocument()
      expect(screen.queryByTestId('ibis-office-preview')).not.toBeInTheDocument()
      await waitFor(() =>
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/document-text')
      )

      screen.getByText('Original').click()
      expect(await screen.findByTestId('ibis-office-preview')).toBeInTheDocument()
      localStorage.clear()
    })

    it('draws a later version of a file that crashed a tab', () => {
      localStorage.setItem('kukan:original-draw:r1:3:gone', String(Date.now() - 60_000))
      render(<ResourcePreview resourceId="r1" format="XLSX" version={4} />)
      expect(screen.getByTestId('ibis-office-preview')).toBeInTheDocument()
      localStorage.clear()
    })

    it('never hands a file to Microsoft’s viewer', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" url="https://example.com/data.xlsx" />)
      expect(document.querySelector('iframe')).toBeNull()
    })
  })

  describe('Office Online preview', () => {
    it('should show local-unavailable for uploaded XLSX on localhost', () => {
      render(<ResourcePreview resourceId="r1" format="XLSX" officePreviewViewer="office-online" />)
      expect(
        screen.getByText(
          'Office preview is not available in local environments. Download the file to view it.'
        )
      ).toBeInTheDocument()
    })

    it('should show local-unavailable for uploaded DOCX on localhost', () => {
      render(<ResourcePreview resourceId="r1" format="DOCX" officePreviewViewer="office-online" />)
      expect(
        screen.getByText(
          'Office preview is not available in local environments. Download the file to view it.'
        )
      ).toBeInTheDocument()
    })

    it('should render Office Online iframe when external URL is provided', () => {
      render(
        <ResourcePreview
          resourceId="r1"
          format="XLSX"
          url="https://example.com/data.xlsx"
          officePreviewViewer="office-online"
        />
      )
      const iframe = document.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe!.getAttribute('src')).toContain('view.officeapps.live.com')
      expect(iframe!.getAttribute('src')).toContain(
        encodeURIComponent('https://example.com/data.xlsx')
      )
    })

    it('should render Office Online iframe for DOC with external URL', () => {
      render(
        <ResourcePreview
          resourceId="r1"
          format="DOC"
          url="https://example.com/report.doc"
          officePreviewViewer="office-online"
        />
      )
      const iframe = document.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe!.getAttribute('src')).toContain('view.officeapps.live.com')
    })

    it('offers only the extracted text of a non-public dataset’s Office file, never the viewer', async () => {
      mockClientFetch.mockResolvedValue(new Response(null, { status: 404 }))
      render(
        <ResourcePreview
          resourceId="r1"
          format="XLSX"
          url="https://example.com/data.xlsx"
          notPublic
          officePreviewViewer="office-online"
        />
      )
      await waitFor(() =>
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/document-text')
      )
      expect(document.querySelector('iframe')).toBeNull()
      expect(screen.queryByText('Original')).not.toBeInTheDocument()
    })

    it('should route XLS to Office Online preview (not generic not-available)', () => {
      render(<ResourcePreview resourceId="r1" format="XLS" officePreviewViewer="office-online" />)
      expect(screen.queryByText('Preview is not available for this format')).not.toBeInTheDocument()
    })

    it('says where to open an Ichitaro original it cannot draw, beside its extracted text', async () => {
      stubObservers()
      mockClientFetch.mockResolvedValue(new Response(null, { status: 404 }))
      render(<ResourcePreview resourceId="r1" format="JTD" />)
      expect(screen.getByText('Original')).toBeInTheDocument()
      expect(screen.getByText('Extracted text')).toBeInTheDocument()
      expect(
        await screen.findByText(
          'This Ichitaro document could not be shown in the browser (a compressed or broken file, or one too long, for instance). Download it and open it in Ichitaro or Ichitaro Viewer (both for Windows). If its text could be extracted, it can be read under Extracted text.'
        )
      ).toBeInTheDocument()
      expect(mockClientFetch).toHaveBeenCalledWith(
        '/api/v1/resources/r1/preview',
        expect.anything()
      )
    })

    it('offers the extracted text of the formats before 2007, as of the ones after', () => {
      for (const format of ['XLS', 'DOC', 'PPT']) {
        const { unmount } = render(
          <ResourcePreview resourceId="r1" format={format} officePreviewViewer="office-online" />
        )
        expect(screen.getByText('Original')).toBeInTheDocument()
        expect(screen.getByText('Extracted text')).toBeInTheDocument()
        unmount()
      }
    })
  })
})
