import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { dropFiles } from '@/__tests__/drag-drop'
import { ResourceList } from '../resource-list'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

vi.mock('../file-upload-zone', () => ({ FileUploadZone: () => null }))
vi.mock('../pipeline-status-badge', () => ({ PipelineStatusBadge: () => null }))
vi.mock('../resource-version-history', () => ({ ResourceVersionHistory: () => null }))
vi.mock('../primary-key-picker', () => ({ PrimaryKeyPicker: () => null }))

/**
 * jsdom has no layout, so a real pointer drag cannot reach `onDragEnd`. The
 * context is kept — the rows still register as sortables — and only the
 * callback is captured, so what these tests drive is the component's own
 * handler rather than a stand-in for it.
 */
const dnd = vi.hoisted(() => ({ end: undefined as ((event: unknown) => void) | undefined }))

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: ({
      onDragEnd,
      ...props
    }: React.ComponentProps<typeof actual.DndContext> & {
      onDragEnd?: (event: unknown) => void
    }) => {
      dnd.end = onDragEnd
      return <actual.DndContext {...props} onDragEnd={onDragEnd as never} />
    },
  }
})

const mockClientFetch = vi.mocked(clientFetch)

function drag(activeId: string, overId: string) {
  // Called directly rather than through pointer events, so the state it sets
  // has to be flushed the way an event handler's would be
  act(() => dnd.end?.({ active: { id: activeId }, over: { id: overId } }))
}

/** The order and labels the list would save, read off the reorder request. */
async function savedArrangement() {
  fireEvent.click(screen.getByText('Save order'))
  await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
  return JSON.parse(mockClientFetch.mock.calls[0][1]!.body as string)
}

function addSection(name: string) {
  fireEvent.click(screen.getByText('Add section'))
  fireEvent.change(screen.getByLabelText('Section name'), { target: { value: name } })
  fireEvent.click(screen.getByText('Save'))
}

// Empty headings are keyed by a fresh id; pin it so tests can address them
const PENDING = 'section:pending:p1'

const baseProps = { packageId: 'pkg1', onUpdated: () => {} }

const rows = [
  { id: 'r1', name: 'addresses.csv', section: null },
  { id: 'r2', name: 'dictionary.pdf', section: 'docs' },
  { id: 'r3', name: 'codes.csv', section: 'docs' },
]

const roots = [
  { id: 'r1', name: 'a.csv', section: null },
  { id: 'r2', name: 'b.csv', section: null },
  { id: 'r3', name: 'c.csv', section: null },
]

const labels = (ids: string[], sections: (string | null)[]) =>
  ids.map((resourceId, i) => ({ resourceId, section: sections[i] }))

describe('ResourceList drag and drop with sections', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => [] } as Response)
    let n = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => `p${++n}` as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  it('takes in the root row a heading is dragged up past — no row moves', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    drag('section:r2', 'r1')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], ['docs', 'docs', 'docs']),
    })
  })

  it('hands the member a heading is dragged down past to the section above', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    // Let go on its own first member, moving down: the divider rests below it,
    // and the row it passed is the root's, as the root is what stands above
    drag('section:r2', 'r2')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], [null, null, 'docs']),
    })
  })

  it('rests above another heading it is dropped on, whichever way it came', () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'a1', name: 'a1', section: 'a' },
          { id: 'a2', name: 'a2', section: 'a' },
          { id: 'b1', name: 'b1', section: 'b' },
          { id: 'b2', name: 'b2', section: 'b' },
        ]}
      />
    )

    // Down onto b's heading: a takes nothing from b, so it is left empty
    drag('section:a1', 'section:b1')

    expect(screen.getAllByText('b')).toHaveLength(1)
    expect(screen.getByText(/This section is empty/)).toBeInTheDocument()
  })

  it('rests above an empty heading it is dropped on, taking nothing either', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    drag(PENDING, 'section:r2')
    // docs onto the empty heading standing above its own first row: it lets its members go
    drag('section:r2', PENDING)

    expect(screen.getAllByText(/This section is empty/)).toHaveLength(2)
    const below = screen.getByText('docs').compareDocumentPosition(screen.getByText('raw data'))
    expect(below & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((await savedArrangement()).sections).toEqual(
      labels(['r1', 'r2', 'r3'], [null, null, null])
    )
  })

  it('makes a row dropped on a heading that section first member', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    drag('r1', 'section:r2')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], ['docs', 'docs', 'docs']),
    })
  })

  it('joins the section of the row it lands under, and returns to the root at the top', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    drag('r1', 'r2')
    drag('r3', 'r2')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r3', 'r2', 'r1'],
      sections: labels(['r3', 'r2', 'r1'], [null, 'docs', 'docs']),
    })
  })

  it('fills a section that has no members yet when a row is dropped on it', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    drag('r1', PENDING)

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r2', 'r3', 'r1'],
      sections: labels(['r2', 'r3', 'r1'], ['docs', 'docs', 'raw data']),
    })
  })

  it('hands a new section the root resources below where it is set down', async () => {
    render(<ResourceList {...baseProps} resources={roots} />)

    addSection('raw data')
    drag(PENDING, 'r2')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], [null, 'raw data', 'raw data']),
    })
  })

  it('splits a section it is set down inside', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    drag(PENDING, 'r3')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], [null, 'docs', 'raw data']),
    })
  })

  it('stays empty when set down on a heading, and keeps standing as rows pass it', () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    drag(PENDING, 'section:r2')
    drag('r1', 'r3')

    expect(screen.getByText('raw data')).toBeInTheDocument()
    expect(screen.getByText(/This section is empty/)).toBeInTheDocument()
  })

  it('keeps more than one empty heading at a time', () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: null },
          { id: 'r2', name: 'b.csv', section: 'docs' },
        ]}
      />
    )

    addSection('raw data')
    // Dragging a one-member heading below its member releases it and keeps the name as a second empty heading
    drag('section:r2', 'r2')

    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.getByText('raw data')).toBeInTheDocument()
    expect(screen.getAllByText(/This section is empty/)).toHaveLength(2)
  })

  it('keeps the empty heading when creating a resource into it fails', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, json: async () => ({}) } as Response)
    const { container } = render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    expect(screen.getByText('raw data')).toBeInTheDocument()
  })

  it('lets the data take over the heading once a row carries its name', () => {
    const { rerender } = render(<ResourceList {...baseProps} resources={rows} />)

    addSection('raw data')
    rerender(
      <ResourceList
        {...baseProps}
        resources={[...rows, { id: 'r4', name: 'new.csv', section: 'raw data' }]}
      />
    )

    expect(screen.getAllByText('raw data')).toHaveLength(1)
    expect(screen.queryByText(/This section is empty/)).not.toBeInTheDocument()
  })
})

describe('ResourceList heading editing', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => [] } as Response)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'p1' as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  it('takes one row from the section above when dragged up onto its last member', async () => {
    render(
      <ResourceList
        {...baseProps}
        resources={[
          { id: 'r1', name: 'a.csv', section: 'data' },
          { id: 'r2', name: 'b.csv', section: 'data' },
          { id: 'r3', name: 'c.csv', section: 'docs' },
        ]}
      />
    )

    drag('section:r3', 'r2')

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], ['data', 'docs', 'docs']),
    })
  })

  it('locks the heading under edit too, and unlocks again on cancel', () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    fireEvent.click(screen.getByLabelText('Rename section'))
    // Dragging the heading being renamed would move its first member, change its
    // id and strand the editor with every control locked
    expect(screen.getByLabelText('Reorder section')).toBeDisabled()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByLabelText('Reorder section')).toBeEnabled()
    expect(screen.getByText('Add section')).toBeEnabled()
  })

  it('drops the editor when its heading disappears, so nothing stays locked', () => {
    const { rerender } = render(<ResourceList {...baseProps} resources={rows} />)

    fireEvent.click(screen.getByLabelText('Rename section'))
    rerender(<ResourceList {...baseProps} resources={rows.map((r) => ({ ...r, section: null }))} />)

    expect(screen.queryByLabelText('Section name')).not.toBeInTheDocument()
    expect(screen.getByText('Add section')).toBeEnabled()
  })

  it('locks the grips while a heading is being renamed', () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    fireEvent.click(screen.getByLabelText('Rename section'))

    for (const grip of screen.getAllByLabelText('Reorder')) expect(grip).toBeDisabled()
  })

  it('stores the name normalized, so the editor and the server agree on the run', async () => {
    render(<ResourceList {...baseProps} resources={rows} />)

    fireEvent.click(screen.getByLabelText('Rename section'))
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: ' raw / data ' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await savedArrangement()).toEqual({
      resourceIds: ['r1', 'r2', 'r3'],
      sections: labels(['r1', 'r2', 'r3'], [null, 'raw/data', 'raw/data']),
    })
  })
})
