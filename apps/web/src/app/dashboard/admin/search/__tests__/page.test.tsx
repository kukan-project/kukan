import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AdminSearchPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

// Mock react-json-view-lite to avoid rendering issues in tests
vi.mock('react-json-view-lite', () => ({
  JsonView: () => null,
  collapseAllNested: () => false,
  darkStyles: {},
  defaultStyles: {},
}))

const mockClientFetch = vi.mocked(clientFetch)

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const mockStats = {
  enabled: true,
  stats: {
    packages: { docCount: 100, recentDocs: [] },
    resources: { docCount: 500, recentDocs: [] },
    contents: { docCount: 200, recentDocs: [] },
  },
}

const mockBrowseEmpty = { items: [], total: 0, offset: 0, limit: 20 }

describe('AdminSearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClientFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/stats')) {
        return mockFetchResponse(mockStats)
      }
      if (typeof path === 'string' && path.includes('/browse/')) {
        return mockFetchResponse(mockBrowseEmpty)
      }
      return mockFetchResponse({})
    })
  })

  it('renders the page title', () => {
    render(<AdminSearchPage />)
    expect(screen.getByText('Index Management')).toBeInTheDocument()
  })

  it('displays index stats cards', async () => {
    render(<AdminSearchPage />)

    // Wait on a name only the stats response renders: 'packages' is also the
    // browse card's title for the default tab, so it is on screen before the
    // stats land and cannot stand for them.
    await waitFor(() => {
      expect(screen.getByText('resources')).toBeInTheDocument()
    })
    expect(screen.getByText('contents')).toBeInTheDocument()
    // Twice once the stats land: its stat card, and the browse card's title.
    expect(screen.getAllByText('packages')).toHaveLength(2)
  })

  it('shows browse items in table', async () => {
    mockClientFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/stats')) {
        return mockFetchResponse(mockStats)
      }
      if (typeof path === 'string' && path.includes('/browse/')) {
        return mockFetchResponse({
          items: [
            { id: 'pkg-1', source: { title: 'Test Dataset', name: 'test-dataset' } },
            { id: 'pkg-2', source: { title: 'Another Dataset', name: 'another' } },
          ],
          total: 2,
          offset: 0,
          limit: 20,
        })
      }
      return mockFetchResponse({})
    })

    render(<AdminSearchPage />)

    await waitFor(() => {
      expect(screen.getByText('pkg-1')).toBeInTheDocument()
    })
    expect(screen.getByText('Test Dataset')).toBeInTheDocument()
    expect(screen.getByText('pkg-2')).toBeInTheDocument()
  })

  it('shows no documents state', async () => {
    render(<AdminSearchPage />)

    await waitFor(() => {
      expect(screen.getByText('No documents')).toBeInTheDocument()
    })
  })

  it('rebuilds the index first, and points to where the other reprocessing moved', () => {
    render(<AdminSearchPage />)

    expect(screen.getByText('Rebuild search index')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeEnabled()
    expect(screen.queryByText('Regenerate embeddings')).not.toBeInTheDocument()
    expect(
      screen.getByText('All resources are reprocessed from Resource Processing.').closest('a')
    ).toHaveAttribute('href', '/dashboard/admin/jobs')
    expect(
      screen.getByText('Embeddings are regenerated from AI Management.').closest('a')
    ).toHaveAttribute('href', '/dashboard/admin/ai')
  })

  it('places the rebuild above the index it rebuilds', async () => {
    render(<AdminSearchPage />)
    await waitFor(() => expect(screen.getByText('resources')).toBeInTheDocument())

    const rebuild = screen.getByText('Rebuild search index')
    const indexCard = screen.getByText('resources')
    expect(
      rebuild.compareDocumentPosition(indexCard) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('queues a rebuild', async () => {
    render(<AdminSearchPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Rebuild job queued')
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/reindex-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeContent: false }),
    })
  })

  it('has a search input and button', () => {
    render(<AdminSearchPage />)

    expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
  })

  describe('refresh', () => {
    const statsCalls = () =>
      mockClientFetch.mock.calls.filter(([path]) => path === '/api/v1/admin/search/stats').length
    const browseCalls = () =>
      mockClientFetch.mock.calls.filter(([path]) => String(path).includes('/browse/')).length

    beforeEach(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    async function open() {
      vi.useFakeTimers()
      render(<AdminSearchPage />)
      await act(async () => {})
      mockClientFetch.mockClear()
    }

    it('does not refresh on its own', async () => {
      await open()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(statsCalls()).toBe(0)
      expect(browseCalls()).toBe(0)
    })

    it('does not follow the counts after a rebuild either', async () => {
      await open()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
      })
      mockClientFetch.mockClear()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(statsCalls()).toBe(0)
    })

    it('reloads the counts and the document list from the refresh button', async () => {
      await open()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      })

      expect(statsCalls()).toBe(1)
      expect(browseCalls()).toBe(1)
    })
  })
})
