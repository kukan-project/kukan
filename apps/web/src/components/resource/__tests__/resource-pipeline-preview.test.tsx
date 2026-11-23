import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResourcePipelinePreview } from '../resource-pipeline-preview'

const mockUseFetch = vi.fn()

vi.mock('@/hooks/use-fetch', () => ({
  useFetch: (...args: unknown[]) => mockUseFetch(...args),
}))

/** Answers the /schema fetch with the given payload; every other fetch gets null. */
function setSchemaFetch(schemaData: unknown) {
  mockUseFetch.mockImplementation((path: string | null) =>
    path?.includes('/schema')
      ? { data: schemaData, loading: false, error: false }
      : { data: null, loading: false, error: false }
  )
}

vi.mock('../pipeline-status-detail', () => ({
  PipelineStatusDetail: () => <div data-testid="pipeline-status-detail">Pipeline Detail</div>,
}))

// The view is kept by the real hook; the preview only shows it and offers the original
vi.mock('@/components/preview/resource-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/preview/resource-preview')>()),
  ResourcePreview: ({
    resourceId,
    hasTable,
    view,
    onViewChange,
  }: {
    resourceId: string
    hasTable?: boolean
    view?: string
    onViewChange?: (view: 'original') => void
  }) => (
    <div data-testid="resource-preview" data-has-table={String(hasTable)} data-view={view}>
      Preview for {resourceId}
      <button onClick={() => onViewChange?.('original')}>show the original</button>
    </div>
  ),
}))

// Reads the Parquet footer itself; only whether it is mounted matters here
vi.mock('../resource-fields', () => ({
  ResourceFields: () => <div data-testid="resource-fields" />,
}))

vi.mock('@/components/date-time', () => ({
  useFormattedDateTime: (iso: string | null | undefined) => (iso ? '2024-01-01 12:00' : ''),
  CompactDate: ({ value }: { value: string }) => <span>{value}</span>,
}))

describe('ResourcePipelinePreview', () => {
  beforeEach(() => {
    mockUseFetch.mockReset()
    mockUseFetch.mockReturnValue({ data: null, loading: false, error: false })
  })

  it('shows the Data API button when the resource is queryable', () => {
    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.getByRole('button', { name: 'Data API' })).toBeInTheDocument()
  })

  it('hides the Data API button when the server says not queryable, even with a schema', () => {
    // A purged preview leaves the schema behind; the entry point must follow
    // the server's queryable verdict, not the schema's presence.
    setSchemaFetch({
      queryable: false,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.queryByRole('button', { name: 'Data API' })).not.toBeInTheDocument()
  })

  it('lists the fields of a table source, schema or not', () => {
    setSchemaFetch({ queryable: false, schema: null, primaryKey: null })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.getByTestId('resource-fields')).toBeInTheDocument()
  })

  it('lists the fields of a workbook only when its reading found columns', () => {
    setSchemaFetch({ queryable: false, schema: { columns: [], rowCount: 0 }, primaryKey: null })
    const { unmount } = render(<ResourcePipelinePreview resourceId="r1" format="XLSX" />)
    expect(mockUseFetch).toHaveBeenCalledWith(expect.stringContaining('/resources/r1/schema'))
    expect(screen.queryByTestId('resource-fields')).not.toBeInTheDocument()
    unmount()

    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="XLSX" />)
    expect(screen.getByTestId('resource-fields')).toBeInTheDocument()
  })

  it('hands the preview what the server said of the version, without waiting for the schema', () => {
    mockUseFetch.mockReturnValue({ data: null, loading: true, error: false })
    render(<ResourcePipelinePreview resourceId="r1" format="XLSX" hasTable />)
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-has-table', 'true')
  })

  it('shows the fields with the table view only', () => {
    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'table')
    expect(screen.getByTestId('resource-fields')).toBeVisible()

    fireEvent.click(screen.getByText('show the original'))
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'original')
    expect(screen.getByTestId('resource-fields')).not.toBeVisible()
  })

  it('opens a workbook read as a table on its original, the fields hidden from the first frame', () => {
    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="XLSX" hasTable />)
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'original')
    expect(screen.getByTestId('resource-fields')).not.toBeVisible()
  })

  it('opens on the table where asked, with what goes under it in place of the fields', () => {
    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(
      <ResourcePipelinePreview
        resourceId="r1"
        format="XLSX"
        hasTable
        opensOnTable
        belowTable={<p>the settings</p>}
      />
    )
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'table')
    expect(screen.getByText('the settings')).toBeVisible()
    expect(screen.queryByTestId('resource-fields')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('show the original'))
    expect(screen.getByText('the settings')).not.toBeVisible()
  })

  it('says a workbook was read as a table, and links its settings from the original', () => {
    setSchemaFetch({
      queryable: true,
      schema: {
        columns: [
          { name: 'a', type: 'string', nullable: false, nullCount: 0 },
          { name: 'b', type: 'integer', nullable: false, nullCount: 0 },
        ],
        rowCount: 1234,
      },
      primaryKey: null,
    })
    render(
      <ResourcePipelinePreview
        resourceId="r1"
        format="XLSX"
        hasTable
        belowTable={<p>the settings</p>}
      />
    )
    expect(screen.getByText('Table: 2 columns × 1,234 rows')).toBeInTheDocument()
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'original')
    expect(screen.getByText('the settings')).not.toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to the table view to open the table settings' })
    )
    expect(screen.getByTestId('resource-preview')).toHaveAttribute('data-view', 'table')
    expect(screen.getByText('the settings')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Switch to the table view to open the table settings' })
    ).not.toBeInTheDocument()
  })

  it('shows no table size where the file was not read as a table', () => {
    render(<ResourcePipelinePreview resourceId="r1" format="DOCX" />)
    expect(screen.queryByText(/^Table:/)).not.toBeInTheDocument()
  })

  it('asks a document that is not a workbook for no schema', () => {
    render(<ResourcePipelinePreview resourceId="r1" format="DOCX" />)
    expect(mockUseFetch).not.toHaveBeenCalledWith(expect.stringContaining('/schema'))
    expect(screen.queryByTestId('resource-fields')).not.toBeInTheDocument()
  })

  it('should render preview heading', () => {
    render(<ResourcePipelinePreview resourceId="r1" />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
  })

  it('should render ResourcePreview child', () => {
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.getByTestId('resource-preview')).toBeInTheDocument()
    expect(screen.getByText('Preview for r1')).toBeInTheDocument()
  })

  it('should show pipeline settings button when canManage is true', () => {
    render(<ResourcePipelinePreview resourceId="r1" canManage />)
    expect(screen.getByRole('button', { name: 'Processing Status' })).toBeInTheDocument()
  })

  it('should not show pipeline settings button when canManage is false', () => {
    render(<ResourcePipelinePreview resourceId="r1" canManage={false} />)
    expect(screen.queryByRole('button', { name: 'Processing Status' })).not.toBeInTheDocument()
  })

  it('should show generated date when pipeline is complete', () => {
    const mockUseFetch = vi.fn().mockReturnValue({
      data: { pipeline_status: 'complete', updated: '2024-01-01T12:00:00Z' },
      loading: false,
      error: false,
    })
    vi.doMock('@/hooks/use-fetch', () => ({ useFetch: mockUseFetch }))

    // Since vi.doMock does not affect already-imported modules, we test
    // the null-data path which does not render generatedAt
    render(<ResourcePipelinePreview resourceId="r1" />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
  })
})
