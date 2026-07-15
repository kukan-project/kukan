import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { MAX_UPLOAD_SIZE } from '@kukan/shared'
import { ResourceList } from '../resource-list'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Captures the latest onComplete so tests can fire it after unmount
const uploadZone = vi.hoisted(() => ({ onComplete: undefined as (() => void) | undefined }))

vi.mock('../file-upload-zone', () => ({
  FileUploadZone: ({ resourceId, onComplete }: { resourceId: string; onComplete?: () => void }) => {
    uploadZone.onComplete = onComplete
    return (
      <div data-testid="file-upload-zone">
        {resourceId}
        <button onClick={onComplete}>complete-upload</button>
      </div>
    )
  },
}))

vi.mock('../pipeline-status-badge', () => ({
  PipelineStatusBadge: () => null,
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

/** Returns false when the default action was prevented (as fireEvent does) */
function dropFiles(target: Element, files: File[]) {
  return fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } })
}

describe('ResourceList drop-to-create', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  // Tests that assert on onUpdated pass their own vi.fn()
  const baseProps = {
    packageId: 'pkg1',
    resources: [],
    onUpdated: () => {},
  }

  it('should create a resource and start upload when a file is dropped', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [
      new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' }),
    ])

    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toHaveTextContent('res1')
    })
    expect(mockClientFetch).toHaveBeenCalledWith(
      '/api/v1/packages/pkg1/resources',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.name).toBe('data.csv')
    expect(body.urlType).toBe('upload')
    expect(body.format).toBeTruthy()
  })

  it('should accept drops when resources already exist', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res2' }))
    const { container } = render(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'r1', name: 'existing.csv', urlType: 'upload', format: 'CSV' }]}
      />
    )

    dropFiles(container.firstElementChild!, [new File(['a'], 'new.csv', { type: 'text/csv' })])

    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toHaveTextContent('res2')
    })
    // The existing resource row is still there
    expect(screen.getByText('existing.csv')).toBeInTheDocument()
  })

  it('should create one resource per dropped file', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'res1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'res2' }))
    const { container } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
      new File(['b'], 'b.json', { type: 'application/json' }),
    ])

    await waitFor(() => {
      expect(screen.getAllByTestId('file-upload-zone')).toHaveLength(2)
    })
    expect(mockClientFetch).toHaveBeenCalledTimes(2)
  })

  it('should remove the upload row and refetch when upload completes', async () => {
    const onUpdated = vi.fn()
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(<ResourceList {...baseProps} onUpdated={onUpdated} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('complete-upload'))
    expect(screen.queryByTestId('file-upload-zone')).not.toBeInTheDocument()
    // The refetch is debounced to coalesce simultaneous completions
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
  })

  it('should serialize resource creation for concurrent drops', async () => {
    let resolveFirst!: (v: Response) => void
    mockClientFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse({ id: 'res2' }))
    const { container } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
      new File(['b'], 'b.csv', { type: 'text/csv' }),
    ])

    // The second create must wait for the first (keeps positions in drop order)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockClientFetch).toHaveBeenCalledTimes(1)

    resolveFirst(jsonResponse({ id: 'res1' }))
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2))
  })

  it('should hide the table row of a resource that is still uploading', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container, rerender } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toHaveTextContent('res1')
    })

    // A mid-upload refetch returns the freshly created resource — its normal
    // row must stay hidden while the upload card is still showing
    rerender(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'res1', name: 'a.csv', urlType: 'upload', format: 'CSV' }]}
      />
    )
    expect(screen.queryAllByRole('row')).toHaveLength(0)
    expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
  })

  it('should reject files over the size limit without creating a resource', async () => {
    const { container } = render(<ResourceList {...baseProps} />)

    const file = new File(['x'], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: MAX_UPLOAD_SIZE + 1 })
    dropFiles(container.firstElementChild!, [file])

    await waitFor(() => {
      expect(screen.getByText(/big\.csv/)).toBeInTheDocument()
    })
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('should show an error when resource creation fails', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}, false))
    const { container } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    await waitFor(() => {
      expect(screen.getByText(/Failed to add resource/)).toBeInTheDocument()
    })
  })

  it('should create resources from files selected via the drop zone input', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(<ResourceList {...baseProps} />)

    const input = container.querySelector('input[type="file"][multiple]')!
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'picked.csv', { type: 'text/csv' })] },
    })

    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toHaveTextContent('res1')
    })
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.name).toBe('picked.csv')
  })

  it('should hide the drop zone while the create form is open', () => {
    const { container } = render(<ResourceList {...baseProps} />)
    expect(container.querySelector('input[type="file"][multiple]')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Add Resource'))
    expect(container.querySelector('input[type="file"][multiple]')).not.toBeInTheDocument()
  })

  it('should show the resource name in the delete confirmation', () => {
    render(
      <ResourceList {...baseProps} resources={[{ id: 'r1', name: 'weather.csv', format: 'CSV' }]} />
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(
      screen.getByText('Are you sure you want to delete the resource "weather.csv"?')
    ).toBeInTheDocument()
  })

  it('should not show table headers when the create form opens with zero resources', () => {
    render(<ResourceList {...baseProps} />)

    fireEvent.click(screen.getByText('Add Resource'))
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0)
  })

  it('should show table headers when resources exist', () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'r1', name: 'existing.csv', urlType: 'upload', format: 'CSV' }]}
      />
    )
    expect(screen.queryAllByRole('columnheader').length).toBeGreaterThan(0)
  })

  it('should ignore drops while the create form is open but still suppress navigation', () => {
    render(<ResourceList {...baseProps} />)

    fireEvent.click(screen.getByText('Add Resource'))
    const table = screen.getByRole('table')
    const notPrevented = dropFiles(table, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    expect(mockClientFetch).not.toHaveBeenCalled()
    // Default must be prevented, or the browser would navigate to the file
    expect(notPrevented).toBe(false)
  })

  it('should serialize form creation behind pending drop creations', async () => {
    let resolveFirst!: (v: Response) => void
    mockClientFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse({ id: 'res2' }))
    const { container } = render(<ResourceList {...baseProps} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1))

    // Submit the manual form while the drop creation is still in flight
    fireEvent.click(screen.getByText('Add Resource'))
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/x.csv' },
    })
    fireEvent.click(screen.getByText('Add Resource'))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockClientFetch).toHaveBeenCalledTimes(1)

    resolveFirst(jsonResponse({ id: 'res1' }))
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2))
  })

  it('should not schedule a refetch when completion arrives after unmount', async () => {
    const onUpdated = vi.fn()
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container, unmount } = render(<ResourceList {...baseProps} onUpdated={onUpdated} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
    })

    // The whole list unmounts (page navigation) while the upload is finishing;
    // the hook still notifies — no refetch timer may be registered past cleanup
    unmount()
    uploadZone.onComplete!()

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('should allow dismissing an in-progress upload card', async () => {
    const onUpdated = vi.fn()
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(<ResourceList {...baseProps} onUpdated={onUpdated} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(screen.queryByTestId('file-upload-zone')).not.toBeInTheDocument()
    // The resource exists on the server — the list must refetch to show its row
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
  })
})
