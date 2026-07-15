import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { takePendingDropFiles } from '@/lib/pending-drop-files'
import { MAX_UPLOAD_SIZE } from '@kukan/shared'
import { dropFiles } from '@/__tests__/drag-drop'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const pushMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/components/dashboard/dataset/dataset-form', () => ({
  DatasetForm: ({
    mode,
    organizations,
    disabled,
    onBusyChange,
  }: {
    mode: string
    organizations: unknown[]
    disabled?: boolean
    onBusyChange?: (busy: boolean) => void
  }) => (
    <div data-testid="dataset-form" data-mode={mode} data-disabled={String(disabled ?? false)}>
      <button onClick={() => onBusyChange?.(true)}>form-busy</button>
      {organizations.length} orgs
    </div>
  ),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

import NewDatasetPage from '../page'

describe('NewDatasetPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    pushMock.mockReset()
  })

  function mockOrgsAndDraft() {
    mockClientFetch.mockImplementation(async (url) => {
      if (url === '/api/v1/users/me/organizations') return jsonResponse({ items: [] })
      if (url === '/api/v1/packages/drafts') return jsonResponse({ id: 'draft-1' })
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  function dropOnZone(container: HTMLElement, files: File[]) {
    dropFiles(container.querySelector('label')!, files)
  }

  it('should render page title', () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<NewDatasetPage />)
    expect(screen.getByText('Create Dataset')).toBeInTheDocument()
  })

  it('should fetch and pass organizations to form', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'o1', name: 'tokyo', title: 'Tokyo' },
          { id: 'o2', name: 'osaka', title: 'Osaka' },
        ],
      })
    )
    render(<NewDatasetPage />)

    await waitFor(() => {
      expect(screen.getByText('2 orgs')).toBeInTheDocument()
    })
  })

  it('should render DatasetForm in create mode', () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<NewDatasetPage />)

    const form = screen.getByTestId('dataset-form')
    expect(form).toHaveAttribute('data-mode', 'create')
  })

  it('should create a draft and navigate to its edit page when files are dropped', async () => {
    mockOrgsAndDraft()
    const { container } = render(<NewDatasetPage />)

    dropOnZone(container, [new File(['a'], 'data.csv', { type: 'text/csv' })])

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/datasets/draft-1/edit?state=draft')
    })
    expect(mockClientFetch).toHaveBeenCalledWith(
      '/api/v1/packages/drafts',
      expect.objectContaining({ method: 'POST' })
    )
    // The files ride along for the edit page's ResourceList to upload
    expect(takePendingDropFiles('draft-1').map((f) => f.name)).toEqual(['data.csv'])
  })

  it('should reject oversized files without creating a draft', async () => {
    mockOrgsAndDraft()
    const { container } = render(<NewDatasetPage />)

    const file = new File(['x'], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: MAX_UPLOAD_SIZE + 1 })
    dropOnZone(container, [file])

    await waitFor(() => {
      expect(screen.getByText(/big\.csv/)).toBeInTheDocument()
    })
    expect(pushMock).not.toHaveBeenCalled()
    expect(mockClientFetch).not.toHaveBeenCalledWith('/api/v1/packages/drafts', expect.anything())
  })

  it('should show an error when draft creation fails', async () => {
    mockClientFetch.mockImplementation(async (url) => {
      if (url === '/api/v1/users/me/organizations') return jsonResponse({ items: [] })
      return jsonResponse({ detail: 'Draft quota exceeded' }, false)
    })
    const { container } = render(<NewDatasetPage />)

    dropOnZone(container, [new File(['a'], 'data.csv', { type: 'text/csv' })])

    await waitFor(() => {
      expect(screen.getByText('Draft quota exceeded')).toBeInTheDocument()
    })
    // Announced to screen readers — the error appears asynchronously
    expect(screen.getByRole('alert')).toHaveTextContent('Draft quota exceeded')
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('should ignore drops while the form reports itself busy', async () => {
    mockOrgsAndDraft()
    const { container } = render(<NewDatasetPage />)

    fireEvent.click(screen.getByText('form-busy'))
    dropOnZone(container, [new File(['a'], 'data.csv', { type: 'text/csv' })])

    await new Promise((resolve) => setTimeout(resolve, 20))
    const draftCalls = mockClientFetch.mock.calls.filter(
      ([url]) => url === '/api/v1/packages/drafts'
    )
    expect(draftCalls).toHaveLength(0)
  })

  it('should stay exclusive after a successful drop until navigation unmounts the page', async () => {
    mockOrgsAndDraft()
    const { container } = render(<NewDatasetPage />)

    dropOnZone(container, [new File(['a'], 'data.csv', { type: 'text/csv' })])
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledTimes(1)
    })

    // router.push cannot be awaited — a re-drop or a form submit while the
    // navigation is in flight must not create a second draft
    dropOnZone(container, [new File(['b'], 'again.csv', { type: 'text/csv' })])
    await new Promise((resolve) => setTimeout(resolve, 20))

    const draftCalls = mockClientFetch.mock.calls.filter(
      ([url]) => url === '/api/v1/packages/drafts'
    )
    expect(draftCalls).toHaveLength(1)
    expect(screen.getByTestId('dataset-form')).toHaveAttribute('data-disabled', 'true')
  })
})
