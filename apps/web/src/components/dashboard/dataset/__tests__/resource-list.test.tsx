import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
const uploadZone = vi.hoisted(() => ({
  onComplete: undefined as (() => void) | undefined,
  format: undefined as string | undefined,
}))

vi.mock('../file-upload-zone', () => ({
  FileUploadZone: ({
    resourceId,
    onComplete,
    format,
  }: {
    resourceId: string
    onComplete?: () => void
    format?: string
  }) => {
    uploadZone.onComplete = onComplete
    uploadZone.format = format
    return (
      <div data-testid="file-upload-zone">
        {resourceId}
        <button onClick={onComplete}>complete-upload</button>
      </div>
    )
  },
}))

// Stands in for the badge's polling: the only thing this file needs from it is
// the moment it reports a run settling.
vi.mock('../pipeline-status-badge', () => ({
  PipelineStatusBadge: ({
    resourceId,
    onSettled,
  }: {
    resourceId: string
    onSettled?: () => void
  }) => <button onClick={() => onSettled?.()}>{`settle:${resourceId}`}</button>,
}))

vi.mock('../resource-version-history', () => ({
  ResourceVersionHistory: () => null,
}))

// Renders what it was told to reload on, which is what these tests assert.
vi.mock('../primary-key-picker', () => ({
  PrimaryKeyPicker: ({ reloadKey }: { reloadKey?: number | string }) => (
    <div data-testid="picker-reload-key">{String(reloadKey)}</div>
  ),
}))

const mockClientFetch = vi.mocked(clientFetch)

/** The create form's submit — the dialog's own button, not the one that opened it */
function submitCreate() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resource' })
}

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

  it('should offer no public page for a draft dataset (no packageName)', () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[{ id: 'r1', name: 'existing.csv', urlType: 'upload', format: 'CSV' }]}
      />
    )
    expect(screen.queryByRole('link', { name: 'View' })).not.toBeInTheDocument()
  })

  it('should ignore drops while the create form is open but still suppress navigation', () => {
    const { container } = render(<ResourceList {...baseProps} />)

    fireEvent.click(screen.getByText('Add Resource'))
    const notPrevented = dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
    ])

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
    fireEvent.click(submitCreate())

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

  it('reports a resource being filled in as unsaved, and an empty dialog as not', () => {
    // Back or a reload would drop it with the dialog
    const onDirtyChange = vi.fn()
    render(<ResourceList {...baseProps} onDirtyChange={onDirtyChange} />)
    fireEvent.click(screen.getByText('Add Resource'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/a.csv' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
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
    fireEvent.click(submitCreate())

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
    fireEvent.click(submitCreate())

    // The request is still in flight — the gate must already be up
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))

    rejectCreate()
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
  })

  it('should close the gate before an upload-resource create resolves', async () => {
    const onUploadingChange = vi.fn()
    mockClientFetch.mockReturnValue(new Promise<Response>(() => {}))
    render(<ResourceList {...baseProps} onUploadingChange={onUploadingChange} />)

    fireEvent.click(screen.getByText('Add Resource'))
    // Radix tabs select on mousedown
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Upload' }))
    // The form opens in a dialog, drawn outside the list
    const input = document.querySelector('[role="dialog"] input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(submitCreate())

    // The create request is still in flight — the gate must already be up
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

describe('ResourceList sections', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'p1' as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  const baseProps = {
    packageId: 'pkg1',
    resources: [],
    onUpdated: () => {},
  }

  const sectioned = [
    { id: 'r1', name: 'addresses.csv', urlType: 'upload', format: 'CSV', section: null },
    { id: 'r2', name: 'dictionary.pdf', urlType: 'upload', format: 'PDF', section: 'docs' },
    { id: 'r3', name: 'codes.csv', urlType: 'upload', format: 'CSV', section: 'docs' },
  ]

  function addSection(name: string) {
    fireEvent.click(screen.getByText('Add section'))
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: name } })
    fireEvent.click(screen.getByText('Save'))
  }

  it('should draw one heading for a run and none for the root', () => {
    render(<ResourceList {...baseProps} resources={sectioned} />)
    expect(screen.getAllByText('docs')).toHaveLength(1)
  })

  it('should draw the same name twice when a root resource splits the run', () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: 'docs' },
          { id: 'r2', name: 'b.csv', section: null },
          { id: 'r3', name: 'c.csv', section: 'docs' },
        ]}
      />
    )
    expect(screen.getAllByText('docs')).toHaveLength(2)
  })

  it('should send every label with the order once any of them changed', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse([]))
    render(<ResourceList {...baseProps} resources={sectioned} />)

    fireEvent.click(screen.getByLabelText('Dissolve section'))
    fireEvent.click(screen.getByText('Save order'))

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const [url, init] = mockClientFetch.mock.calls[0]
    expect(url).toBe('/api/v1/packages/pkg1/resources/reorder')
    expect(JSON.parse(init!.body as string)).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: [
        { resourceId: 'r1', section: null },
        { resourceId: 'r2', section: null },
        { resourceId: 'r3', section: null },
      ],
    })
  })

  it('should send only the order when no label changed', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse([]))
    render(<ResourceList {...baseProps} resources={sectioned} />)

    // A rename to the same name changes nothing
    fireEvent.click(screen.getByLabelText('Rename section'))
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'docs' } })
    fireEvent.click(screen.getByText('Save'))
    expect(screen.queryByText('Save order')).not.toBeInTheDocument()
  })

  it('should rewrite only the run it renames', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse([]))
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: 'docs' },
          { id: 'r2', name: 'b.csv', section: null },
          { id: 'r3', name: 'c.csv', section: 'docs' },
        ]}
      />
    )

    fireEvent.click(screen.getAllByLabelText('Rename section')[0])
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'papers' } })
    fireEvent.click(screen.getByText('Save'))
    fireEvent.click(screen.getByText('Save order'))

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.sections).toEqual([
      { resourceId: 'r1', section: 'papers' },
      { resourceId: 'r2', section: null },
      { resourceId: 'r3', section: 'docs' },
    ])
  })

  it('should hold a section with no members without saving anything', () => {
    render(<ResourceList {...baseProps} resources={sectioned} />)

    addSection('raw data')
    expect(screen.getByText('raw data')).toBeInTheDocument()
    expect(screen.getByText(/This section is empty/)).toBeInTheDocument()
    expect(screen.queryByText('Save order')).not.toBeInTheDocument()
  })

  it('reports a heading being typed, or one waiting for a row, as unsaved', () => {
    // The editor asks before leaving them, as it does for a staged order
    const onDirtyChange = vi.fn()
    render(<ResourceList {...baseProps} resources={sectioned} onDirtyChange={onDirtyChange} />)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByText('Add section'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'raw data' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('should let a section be named and saved on a dataset with no resources', () => {
    render(<ResourceList {...baseProps} />)

    fireEvent.click(screen.getByText('Add section'))
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'raw data' } })
    fireEvent.click(screen.getByText('Save'))

    expect(screen.getByText('raw data')).toBeInTheDocument()
    expect(screen.getByText(/This section is empty/)).toBeInTheDocument()
    expect(screen.getByText('Add section')).toBeEnabled()
  })

  it('should put the first resource of an empty dataset into the section added first', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'r1' }))
    const { container } = render(<ResourceList {...baseProps} />)

    addSection('raw data')
    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.section).toBe('raw data')
  })

  it('should refuse a new section named like one that already exists', () => {
    render(<ResourceList {...baseProps} resources={sectioned} />)

    fireEvent.click(screen.getByText('Add section'))
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: ' docs ' } })

    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    expect(screen.getByText('Save').closest('button')).toBeDisabled()
  })

  it("should refuse renaming a section to a run's name it is not next to, but allow its own", () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: 'docs' },
          { id: 'r2', name: 'b.csv', section: null },
          { id: 'r3', name: 'c.csv', section: 'data' },
        ]}
      />
    )

    fireEvent.click(screen.getAllByLabelText('Rename section')[1])
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'docs' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Save').closest('button')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'data' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Save').closest('button')).toBeEnabled()
  })

  it('should let a section take the name of the run right above it, joining the two', async () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: 'docs' },
          { id: 'r2', name: 'b.csv', section: 'old' },
        ]}
      />
    )

    fireEvent.click(screen.getAllByLabelText('Rename section')[1])
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: 'docs' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))

    // One run now, so one heading
    expect(screen.getAllByLabelText('Rename section')).toHaveLength(1)
    fireEvent.click(screen.getByText('Save order'))
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.sections).toEqual([
      { resourceId: 'r1', section: 'docs' },
      { resourceId: 'r2', section: 'docs' },
    ])
  })

  it('should drop a section that was never named on cancel', () => {
    render(<ResourceList {...baseProps} resources={sectioned} />)

    fireEvent.click(screen.getByText('Add section'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByLabelText('Section name')).not.toBeInTheDocument()
    expect(screen.getByText('Add section')).toBeEnabled()
  })

  it('should create the next resource inside the section just added', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'r4' }))
    const { container } = render(<ResourceList {...baseProps} resources={sectioned} />)

    addSection('raw data')
    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.section).toBe('raw data')
  })

  it('should put a resource created at the end into the section the end is in', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ id: 'r4' }))
    const { container } = render(<ResourceList {...baseProps} resources={sectioned} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    const body = JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
    expect(body.section).toBe('docs')
  })
})

describe('ResourceList in the editor’s left column', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  const resources = [
    { id: 'r1', name: '2024.csv', format: 'CSV', section: null },
    { id: 'r2', name: '2023.csv', format: 'CSV', section: null },
  ]
  const props = { packageId: 'pkg1', resources, onUpdated: () => {} }

  it('leads each row to the resource’s own page (ADR-072)', () => {
    render(<ResourceList {...props} />)
    expect(screen.getByRole('link', { name: /2024\.csv/ })).toHaveAttribute(
      'href',
      '/dashboard/datasets/pkg1/resources/r1'
    )
  })

  it('marks the resource whose page is open', () => {
    render(<ResourceList {...props} activeId="r2" />)
    expect(screen.getByRole('link', { name: /2023\.csv/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /2024\.csv/ })).not.toHaveAttribute('aria-current')
  })

  it('only shows the rows of a deleted dataset', () => {
    // Nothing of it can be opened, arranged or added to (ADR-072 decision 4)
    render(<ResourceList {...props} readOnly />)
    expect(screen.getByText('2024.csv')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /2024\.csv/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reorder' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add Resource')).not.toBeInTheDocument()
  })
})
