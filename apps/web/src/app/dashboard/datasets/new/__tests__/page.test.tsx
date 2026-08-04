import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { takePendingDropFiles } from '@/lib/pending-drop-files'
import { MAX_UPLOAD_SIZE } from '@kukan/shared'
import { dropFiles } from '@/__tests__/drag-drop'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// The form owns draft creation (kukan#243) — the stub exposes the submit
// counter and lets a test play back the id the real form would report
const form = vi.hoisted(() => ({ draftCreated: null as ((draftId: string) => void) | null }))
vi.mock('@/components/dashboard/dataset/dataset-form', () => ({
  DatasetForm: ({
    mode,
    organizations,
    onBusyChange,
    submitSignal,
    onDraftCreated,
  }: {
    mode: string
    organizations: unknown[]
    onBusyChange?: (busy: boolean) => void
    submitSignal?: number
    onDraftCreated?: (draftId: string) => void
  }) => {
    form.draftCreated = onDraftCreated ?? null
    return (
      <div data-testid="dataset-form" data-mode={mode} data-submit-signal={String(submitSignal)}>
        <button onClick={() => onBusyChange?.(true)}>form-busy</button>
        {organizations.length} orgs
      </div>
    )
  },
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

import NewDatasetPage from '../page'

describe('NewDatasetPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    form.draftCreated = null
  })

  function dropOnZone(container: HTMLElement, files: File[]) {
    dropFiles(container.querySelector('label')!, files)
  }

  const csv = (name = 'data.csv') => new File(['a'], name, { type: 'text/csv' })
  const submitSignal = () => screen.getByTestId('dataset-form').getAttribute('data-submit-signal')

  it('should render page title', () => {
    render(<NewDatasetPage />)
    expect(screen.getByText('Create Dataset')).toBeInTheDocument()
  })

  it('should fetch and pass organizations to form', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'o1', name: 'tokyo', title: 'Tokyo', role: 'admin' },
          { id: 'o2', name: 'osaka', title: 'Osaka', role: 'editor' },
        ],
      })
    )
    render(<NewDatasetPage />)

    await waitFor(() => {
      expect(screen.getByText('2 orgs')).toBeInTheDocument()
    })
  })

  it('should drop organizations the viewer cannot create datasets in', async () => {
    // Creating needs editor in the owning org, so a member-only one would only
    // be rejected on save (kukan#260)
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'o1', name: 'tokyo', title: 'Tokyo', role: 'editor' },
          { id: 'o2', name: 'osaka', title: 'Osaka', role: 'member' },
        ],
      })
    )
    render(<NewDatasetPage />)

    await waitFor(() => {
      expect(screen.getByText('1 orgs')).toBeInTheDocument()
    })
  })

  it('should render DatasetForm in create mode', () => {
    render(<NewDatasetPage />)

    expect(screen.getByTestId('dataset-form')).toHaveAttribute('data-mode', 'create')
  })

  it('should submit the form on drop instead of creating a draft of its own', () => {
    const { container } = render(<NewDatasetPage />)

    dropOnZone(container, [csv()])

    // A draft of the page's own would not carry what the user already typed
    expect(submitSignal()).toBe('1')
    expect(mockClientFetch).not.toHaveBeenCalledWith('/api/v1/packages/drafts', expect.anything())
  })

  it('should stash the dropped files under the draft the form created', () => {
    const { container } = render(<NewDatasetPage />)

    dropOnZone(container, [csv()])
    // The files ride along for the edit page's ResourceList to upload
    form.draftCreated!('draft-1')

    expect(takePendingDropFiles('draft-1').map((f) => f.name)).toEqual(['data.csv'])
  })

  it('should stash nothing when the form was submitted without a drop', () => {
    render(<NewDatasetPage />)

    form.draftCreated!('draft-2')

    expect(takePendingDropFiles('draft-2')).toEqual([])
  })

  it('should reject oversized files without submitting the form', async () => {
    const { container } = render(<NewDatasetPage />)

    const file = csv('big.csv')
    Object.defineProperty(file, 'size', { value: MAX_UPLOAD_SIZE + 1 })
    dropOnZone(container, [file])

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/big\.csv/)
    })
    expect(submitSignal()).toBe('0')
  })

  it('should ignore drops while the form reports itself busy', () => {
    const { container } = render(<NewDatasetPage />)

    fireEvent.click(screen.getByText('form-busy'))
    dropOnZone(container, [csv()])

    expect(submitSignal()).toBe('0')
  })
})
