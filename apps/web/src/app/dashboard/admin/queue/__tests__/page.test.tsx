import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useVisibleInterval } from '@/hooks/use-visible-interval'
import * as shared from '@kukan/shared'
import enMessages from '../../../../../../messages/en.json'
import jaMessages from '../../../../../../messages/ja.json'
import AdminQueuePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

const mockPaginatedFetch = {
  items: [] as unknown[],
  loading: false,
  error: null as Error | null,
  fetchPage: vi.fn(),
  refresh: vi.fn(),
  offset: 0,
  total: 0,
  pageSize: 20,
  totalPages: 0,
  currentPage: 1,
}
vi.mock('@/hooks/use-paginated-fetch', () => ({
  usePaginatedFetch: vi.fn(() => mockPaginatedFetch),
}))

vi.mock('@/hooks/use-visible-interval', () => ({
  useVisibleInterval: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)
const mockUseVisibleInterval = vi.mocked(useVisibleInterval)
const lastPoll = () => mockUseVisibleInterval.mock.calls.at(-1)!
const mockUsePaginatedFetch = vi.mocked(usePaginatedFetch)

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response

const deadJob = {
  id: 'job-1',
  type: 'summarize-package',
  payload: { packageId: 'p1' },
  status: 'dead',
  priority: 'low',
  attempts: 3,
  lastError: 'completion timed out',
  updated: '2026-09-27T00:00:00Z',
}

describe('AdminQueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPaginatedFetch.items = []
    mockPaginatedFetch.total = 0
    mockPaginatedFetch.offset = 0
    mockClientFetch.mockResolvedValue(
      ok({
        items: [
          { type: 'resource-pipeline', status: 'running', count: 1 },
          { type: 'resource-pipeline', status: 'waiting', count: 392 },
          { type: 'sync-search-docs', status: 'waiting', count: 113 },
          { type: 'summarize-package', status: 'dead', count: 3 },
        ],
      })
    )
    mockUsePaginatedFetch.mockReturnValue(
      mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>
    )
  })

  it('opens on the running jobs of every type', () => {
    render(<AdminQueuePage />)

    expect(mockUsePaginatedFetch).toHaveBeenCalledWith('/api/v1/admin/queue/jobs?status=running')
  })

  it('counts jobs by type and status, with a total row', async () => {
    render(<AdminQueuePage />)

    const pipeline = (await screen.findByText('Pipeline run (resources)')).closest('tr')!
    expect(within(pipeline).getByRole('button', { name: '392' })).toBeInTheDocument()
    const sync = screen.getByText('Metadata search index sync (datasets, resources)').closest('tr')!
    expect(within(sync).getByRole('button', { name: '113' })).toBeInTheDocument()
    const total = screen.getByText('Total').closest('tr')!
    expect(within(total).getByRole('button', { name: '505' })).toBeInTheDocument()
    // Every type has a row, with no jobs as much as with some
    const purge = screen.getByText('Purge (organizations)').closest('tr')!
    expect(within(purge).getAllByRole('button', { name: '0' })).toHaveLength(4)
  })

  it('places every job type in a section of its own, under its own name', async () => {
    // A job type added to the shared package but not here would drop into
    // "Other", and only while it had jobs, under its raw id
    const jobTypes = Object.entries(shared)
      .filter(([name]) => name.endsWith('_JOB_TYPE'))
      .map(([, type]) => type as string)
    mockClientFetch.mockResolvedValueOnce(ok({ items: [] }))
    render(<AdminQueuePage />)
    await screen.findByText('Total')

    expect(jobTypes.length).toBeGreaterThan(10)
    for (const type of jobTypes) {
      const ja = (jaMessages.dashboard.adminQueue.types as Record<string, string>)[type]
      const label = (enMessages.dashboard.adminQueue.types as Record<string, string>)[type]
      expect({ type, ja: !!ja, en: !!label }).toEqual({ type, ja: true, en: true })
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
  })

  it('groups the types by what sets them off, with anything unknown last', async () => {
    mockClientFetch.mockResolvedValueOnce(
      ok({ items: [{ type: 'something-new', status: 'waiting', count: 2 }] })
    )
    render(<AdminQueuePage />)
    await screen.findByText('something-new')

    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '')
    const at = (text: string) => rows.findIndex((r) => r.startsWith(text))
    const order = [
      'Routine',
      'Pipeline run (resources)',
      'Version lake ingest',
      'Metadata search index sync',
      'Embeddings',
      'Admin actions and recovery',
      'Search index rebuild',
      'AI descriptions in bulk',
      'AI descriptions (resources)',
      'Version deletion',
      'Purge (organizations)',
      'Migrations after an upgrade',
      'Version backfill',
      'Set-aside version conversion',
      'Preview row-group recording',
      'Search index re-analysis',
      'Other',
      'something-new',
      'Total',
    ].map(at)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('lists one type of one status from its cell', async () => {
    render(<AdminQueuePage />)

    const sync = (
      await screen.findByText('Metadata search index sync (datasets, resources)')
    ).closest('tr')!
    fireEvent.click(within(sync).getByRole('button', { name: '113' }))
    expect(mockUsePaginatedFetch).toHaveBeenLastCalledWith(
      '/api/v1/admin/queue/jobs?status=waiting&type=sync-search-docs'
    )
  })

  it('shows what a dead job was for and why it stopped', () => {
    mockPaginatedFetch.items = [deadJob]
    mockPaginatedFetch.total = 1
    render(<AdminQueuePage />)

    expect(screen.getAllByText('AI descriptions (resources)').length).toBeGreaterThan(0)
    expect(screen.getByText('summarize-package')).toBeInTheDocument()
    expect(screen.getByText('packageId=p1')).toBeInTheDocument()
    expect(screen.getByText('completion timed out')).toBeInTheDocument()
  })

  it('says which jobs are taken ahead of the rest and which behind', () => {
    mockPaginatedFetch.items = [
      { ...deadJob, id: 'a', status: 'waiting', priority: 'high', lastError: null },
      { ...deadJob, id: 'b', status: 'waiting', priority: 'normal', lastError: null },
      { ...deadJob, id: 'c', status: 'waiting', priority: 'low', lastError: null },
    ]
    render(<AdminQueuePage />)

    expect(screen.getByRole('columnheader', { name: 'Priority' })).toBeInTheDocument()
    for (const label of ['High', 'Normal', 'Low']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('retries a dead job', async () => {
    mockPaginatedFetch.items = [deadJob]
    render(<AdminQueuePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/queue/jobs/job-1/retry', {
        method: 'POST',
      })
    )
  })

  it('says so when an action fails', async () => {
    mockPaginatedFetch.items = [deadJob]
    render(<AdminQueuePage />)
    mockClientFetch.mockResolvedValueOnce({ ok: false } as Response)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The action failed')
  })

  it('says so, and gives the buttons back, when the request cannot be sent', async () => {
    mockPaginatedFetch.items = [deadJob]
    render(<AdminQueuePage />)
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The action failed')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
  })

  it('closes the delete dialog once the delete succeeded, whether or not the counts reload', async () => {
    mockPaginatedFetch.items = [deadJob]
    render(<AdminQueuePage />)
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled())
    mockClientFetch
      .mockResolvedValueOnce(ok({ deleted: true }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no actions on a job that is still queued', () => {
    mockPaginatedFetch.items = [{ ...deadJob, status: 'waiting', attempts: 0, lastError: null }]
    render(<AdminQueuePage />)

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
  it('polls the counts and the page shown, spinning the refresh icon meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<AdminQueuePage />)
      await act(async () => {})
      const spinning = () => container.querySelector('svg.animate-spin')
      mockClientFetch.mockClear()

      const [poll, , enabled] = lastPoll()
      expect(enabled).toBe(true)
      let settled = false
      act(() => {
        ;(poll() as Promise<void>).then(() => (settled = true))
      })

      expect(mockPaginatedFetch.refresh).toHaveBeenCalled()
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/queue/counts')
      expect(spinning()).not.toBeNull()

      // Held for a full turn, however fast the requests came back
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999)
      })
      expect(spinning()).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(settled).toBe(true)
      expect(spinning()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling while the delete dialog is open', async () => {
    mockPaginatedFetch.items = [deadJob]
    render(<AdminQueuePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')

    expect(lastPoll()[2]).toBe(false)
  })
})
