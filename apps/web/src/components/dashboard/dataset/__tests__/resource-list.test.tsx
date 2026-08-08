import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { stashPendingDropFiles } from '@/lib/pending-drop-files'
import { MAX_UPLOAD_SIZE } from '@kukan/shared'
import { dropFiles } from '@/__tests__/drag-drop'
import { ResourceList } from '../resource-list'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
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

vi.mock('../resource-version-history', () => ({
  ResourceVersionHistory: () => null,
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
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

  it('should start uploads for files stashed from the new-dataset page', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    stashPendingDropFiles('pkg1', [new File(['a'], 'stashed.csv', { type: 'text/csv' })])

    render(<ResourceList {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toHaveTextContent('res1')
    })
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.name).toBe('stashed.csv')
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

  it('should remove the upload card once the post-completion refetch landed', async () => {
    const onUpdated = vi.fn()
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(<ResourceList {...baseProps} onUpdated={onUpdated} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
    })

    // The refetch is debounced to coalesce simultaneous completions; the card
    // stays until it lands so the row appears with a fresh pipeline status
    fireEvent.click(screen.getByText('complete-upload'))
    expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.queryByTestId('file-upload-zone')).not.toBeInTheDocument()
    })
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

  it('should report uploading until the refetch after completion lands', async () => {
    const onUploadingChange = vi.fn()
    let resolveUpdate!: () => void
    const onUpdated = vi.fn(() => new Promise<void>((resolve) => (resolveUpdate = resolve)))
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(
      <ResourceList {...baseProps} onUpdated={onUpdated} onUploadingChange={onUploadingChange} />
    )

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))

    // Upload done: the card is kept and uploading stays true until the
    // refetch made the fresh pipeline status visible
    fireEvent.click(screen.getByText('complete-upload'))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    expect(onUploadingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()

    resolveUpdate()
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByTestId('file-upload-zone')).not.toBeInTheDocument()
  })

  it('should keep the busy gate up when the refetch fails', async () => {
    const onUploadingChange = vi.fn()
    let resolveUpdate!: (ok: boolean) => void
    const onUpdated = vi.fn(() => new Promise<boolean>((resolve) => (resolveUpdate = resolve)))
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'res1' }))
    const { container } = render(
      <ResourceList {...baseProps} onUpdated={onUpdated} onUploadingChange={onUploadingChange} />
    )

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])
    await waitFor(() => expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument())
    fireEvent.click(screen.getByText('complete-upload'))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())

    // A failed refresh must not clear the flag or the card — a retry runs later
    resolveUpdate(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onUploadingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument()
  })

  it('should hold the busy gate after creating a url resource', async () => {
    // The server enqueues the pipeline at creation for url resources
    const onUploadingChange = vi.fn()
    let resolveUpdate!: (ok: boolean) => void
    const onUpdated = vi.fn(() => new Promise<boolean>((resolve) => (resolveUpdate = resolve)))
    mockClientFetch.mockResolvedValue(
      jsonResponse({ id: 'res1', url: 'https://example.com/a.csv', urlType: null })
    )
    render(
      <ResourceList {...baseProps} onUpdated={onUpdated} onUploadingChange={onUploadingChange} />
    )

    fireEvent.click(screen.getByText('Add Resource'))
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/a.csv' },
    })
    fireEvent.click(screen.getByText('Add Resource'))

    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    resolveUpdate(true)
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
  })

  it('should close the gate before a url-resource create resolves and release it on failure', async () => {
    const onUploadingChange = vi.fn()
    let rejectCreate!: () => void
    mockClientFetch.mockImplementation(
      () =>
        new Promise<Response>((_, reject) => (rejectCreate = () => reject(new Error('network'))))
    )
    render(<ResourceList {...baseProps} onUploadingChange={onUploadingChange} />)

    fireEvent.click(screen.getByText('Add Resource'))
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/a.csv' },
    })
    fireEvent.click(screen.getByText('Add Resource'))

    // The request is still in flight — the gate must already be up
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))

    rejectCreate()
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
  })

  it('toggles the inline editor open and closed on row click', async () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'r1', name: 'data.csv', urlType: 'upload', format: 'CSV' }]}
      />
    )

    // First row click opens the editor.
    fireEvent.click(screen.getByText('data.csv'))
    expect(screen.getByText('Save')).toBeInTheDocument()

    // Clicking the same row again closes it (toggle).
    fireEvent.click(screen.getByText('data.csv'))
    expect(screen.queryByText('Save')).not.toBeInTheDocument()
  })

  it('should close the gate before a url-resource save resolves', async () => {
    const onUploadingChange = vi.fn()
    mockClientFetch.mockReturnValue(new Promise<Response>(() => {}))
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'data.csv', url: 'https://example.com/a.csv', urlType: null },
        ]}
        onUploadingChange={onUploadingChange}
      />
    )

    // Row click opens the inline editor (the Edit button was removed)
    fireEvent.click(screen.getByText('data.csv'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))
  })

  it('should close the gate before an upload-resource create resolves', async () => {
    const onUploadingChange = vi.fn()
    mockClientFetch.mockReturnValue(new Promise<Response>(() => {}))
    const { container } = render(
      <ResourceList {...baseProps} onUploadingChange={onUploadingChange} />
    )

    fireEvent.click(screen.getByText('Add Resource'))
    // Radix tabs select on mousedown
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Upload' }))
    const input = container.querySelector('input[type="file"]:not([multiple])')!
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(screen.getByText('Add Resource'))

    // The create request is still in flight — the gate must already be up
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))
  })

  it('should close the gate before a file-replace save resolves', async () => {
    const onUploadingChange = vi.fn()
    mockClientFetch.mockReturnValue(new Promise<Response>(() => {}))
    const { container } = render(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'r1', name: 'data.csv', urlType: 'upload', format: 'CSV' }]}
        onUploadingChange={onUploadingChange}
      />
    )

    // Row click opens the inline editor (the Edit button was removed)
    fireEvent.click(screen.getByText('data.csv'))
    fireEvent.click(screen.getByText('Replace file'))
    const input = container.querySelector('input[type="file"]:not([multiple])')!
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'new.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))
  })

  it('should not clear the gate when the newest of overlapping refetches failed', async () => {
    const onUploadingChange = vi.fn()
    const resolvers: Array<(ok: boolean) => void> = []
    const onUpdated = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)))
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'res1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'res2' }))
    const { container } = render(
      <ResourceList {...baseProps} onUpdated={onUpdated} onUploadingChange={onUploadingChange} />
    )

    dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
      new File(['b'], 'b.csv', { type: 'text/csv' }),
    ])
    await waitFor(() => expect(screen.getAllByTestId('file-upload-zone')).toHaveLength(2))

    fireEvent.click(screen.getAllByText('complete-upload')[0])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByText('complete-upload')[1])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))

    // The newer fetch failed — the older success must not clear the gate
    resolvers[1](false)
    resolvers[0](true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onUploadingChange).toHaveBeenLastCalledWith(true)
  })

  it('should keep reporting uploading while overlapping refetches are in flight', async () => {
    const onUploadingChange = vi.fn()
    const resolvers: Array<() => void> = []
    const onUpdated = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)))
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'res1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'res2' }))
    const { container } = render(
      <ResourceList {...baseProps} onUpdated={onUpdated} onUploadingChange={onUploadingChange} />
    )

    dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
      new File(['b'], 'b.csv', { type: 'text/csv' }),
    ])
    await waitFor(() => expect(screen.getAllByTestId('file-upload-zone')).toHaveLength(2))

    // First refetch starts executing, then the second completion starts its own
    fireEvent.click(screen.getAllByText('complete-upload')[0])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByText('complete-upload')[1])
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))

    // The first finishing must not drop the flag while the second runs
    resolvers[0]()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onUploadingChange).toHaveBeenLastCalledWith(true)

    resolvers[1]()
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
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
