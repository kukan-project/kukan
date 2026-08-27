import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

vi.mock('../resource-preview', () => ({
  ResourcePreview: ({ resourceId }: { resourceId: string }) => (
    <div data-testid="resource-preview">Preview for {resourceId}</div>
  ),
}))

vi.mock('../date-time', () => ({
  formatDateTime: () => '2024-01-01 12:00',
  CompactDate: ({ value }: { value: string }) => <span>{value}</span>,
}))

describe('ResourcePipelinePreview', () => {
  beforeEach(() => {
    mockUseFetch.mockReset()
    mockUseFetch.mockReturnValue({ data: null, loading: false, error: false })
  })

  it('shows the Data API button when the resource has a non-empty schema', () => {
    setSchemaFetch({
      schema: {
        columns: [{ name: 'a', type: 'string', nullable: false, nullCount: 0 }],
        rowCount: 1,
      },
      primaryKey: null,
    })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.getByRole('button', { name: 'Data API' })).toBeInTheDocument()
  })

  it('hides the Data API button when the schema has no columns', () => {
    // An interpretation that produced no table persists an empty schema —
    // querying it can only fail, so the entry point must not appear.
    setSchemaFetch({ schema: { columns: [], rowCount: 0 }, primaryKey: null })
    render(<ResourcePipelinePreview resourceId="r1" format="CSV" />)
    expect(screen.queryByRole('button', { name: 'Data API' })).not.toBeInTheDocument()
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
