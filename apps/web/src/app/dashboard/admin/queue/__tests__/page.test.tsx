import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePaginatedFetch } from '@/hooks/use-paginated-fetch'
import { useVisibleInterval } from '@/hooks/use-visible-interval'
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
          { type: 'sync-resource-doc', status: 'waiting', count: 113 },
          { type: 'summarize-package', status: 'dead', count: 3 },
        ],
      })
    )
    mockUsePaginatedFetch.mockReturnValue(
      mockPaginatedFetch as ReturnType<typeof usePaginatedFetch>
    )
  })

  it('opens on the scheduled jobs of every type', () => {
    render(<AdminQueuePage />)

    expect(mockUsePaginatedFetch).toHaveBeenCalledWith('/api/v1/admin/queue/jobs?status=scheduled')
  })

  it('counts jobs by type and status, with a total row', async () => {
    render(<AdminQueuePage />)

    const pipeline = (await screen.findByText('Resource pipeline')).closest('tr')!
    expect(within(pipeline).getByRole('button', { name: '392' })).toBeInTheDocument()
    const sync = screen.getByText('Search document sync').closest('tr')!
    expect(within(sync).getByRole('button', { name: '113' })).toBeInTheDocument()
    const total = screen.getByText('Total').closest('tr')!
    expect(within(total).getByRole('button', { name: '505' })).toBeInTheDocument()
    // Every type has a row, with no jobs as much as with some
    const purge = screen.getByText('Organization purge').closest('tr')!
    expect(within(purge).getAllByRole('button', { name: '0' })).toHaveLength(4)
  })

  it('lists one type of one status from its cell', async () => {
    render(<AdminQueuePage />)

    const sync = (await screen.findByText('Search document sync')).closest('tr')!
    fireEvent.click(within(sync).getByRole('button', { name: '113' }))
    expect(mockUsePaginatedFetch).toHaveBeenLastCalledWith(
      '/api/v1/admin/queue/jobs?status=waiting&type=sync-resource-doc'
    )
  })

  it('shows what a dead job was for and why it stopped', () => {
    mockPaginatedFetch.items = [deadJob]
    mockPaginatedFetch.total = 1
    render(<AdminQueuePage />)

    expect(screen.getAllByText('Dataset abstracts').length).toBeGreaterThan(0)
    expect(screen.getByText('summarize-package')).toBeInTheDocument()
    expect(screen.getByText('packageId=p1')).toBeInTheDocument()
    expect(screen.getByText('completion timed out')).toBeInTheDocument()
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
