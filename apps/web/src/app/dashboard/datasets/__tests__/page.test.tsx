import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import DatasetsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const sampleItems = [
  {
    id: '1',
    name: 'population-data',
    title: 'Population Data',
    private: false,
    formats: 'CSV',
    orgTitle: 'Tokyo',
    tags: 'statistics,population',
    groups: 'demographics:Demographics',
  },
  {
    id: '2',
    name: 'budget-report',
    title: 'Budget Report',
    private: true,
    formats: 'PDF,XLSX',
    orgTitle: 'Osaka',
  },
]

// Default mock: org/group options fetch + packages fetch
function setupDefaultMocks(items = sampleItems, total = items.length) {
  vi.mocked(clientFetch).mockImplementation(async (path: string) => {
    if (path.includes('/api/v1/organizations')) {
      return mockFetchResponse({ items: [{ id: 'o1', name: 'tokyo', title: 'Tokyo' }] })
    }
    if (path.includes('/api/v1/groups')) {
      return mockFetchResponse({ items: [{ id: 'g1', name: 'demo', title: 'Demographics' }] })
    }
    return mockFetchResponse({ items, total })
  })
}

describe('DatasetsManagePage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('should display datasets in table', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('population-data')).toBeInTheDocument()
    })
    expect(screen.getByText('Population Data')).toBeInTheDocument()
    expect(screen.getByText('budget-report')).toBeInTheDocument()
    expect(screen.getByText('Budget Report')).toBeInTheDocument()
  })

  it('should show visibility badges', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Public')).toBeInTheDocument()
    })
    expect(screen.getByText('Private')).toBeInTheDocument()
  })

  it('should show organization and tags in metadata row', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Tokyo')).toBeInTheDocument()
    })
    expect(screen.getByText('statistics, population')).toBeInTheDocument()
    expect(screen.getByText('Demographics')).toBeInTheDocument()
  })

  it('should show empty state when no datasets', async () => {
    setupDefaultMocks([], 0)
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('No datasets')).toBeInTheDocument()
    })
  })

  it('should show pagination when total > pageSize', async () => {
    setupDefaultMocks(sampleItems, 50)
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })
    expect(screen.getByText('Next')).toBeInTheDocument()
  })

  it('should not show pagination when total <= pageSize', async () => {
    setupDefaultMocks(sampleItems, 2)
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('population-data')).toBeInTheDocument()
    })
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('should render filter bar with labels', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('population-data')).toBeInTheDocument()
    })

    // Filter inputs
    expect(screen.getByPlaceholderText('name...')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search datasets...')).toBeInTheDocument()
    // Select triggers (rendered as combobox)
    const comboboxes = screen.getAllByRole('combobox')
    expect(comboboxes.length).toBe(3) // org, category, visibility
  })

  it('should link to edit page', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => {
      const editLinks = screen.getAllByText('Edit')
      const link = editLinks[0].closest('a')
      expect(link).toHaveAttribute('href', '/dashboard/datasets/population-data/edit')
    })
  })

  it('should show error state with retry button on fetch failure', async () => {
    vi.mocked(clientFetch).mockImplementation(async (path: string) => {
      if (path.includes('/api/v1/organizations')) {
        return mockFetchResponse({ items: [] })
      }
      if (path.includes('/api/v1/groups')) {
        return mockFetchResponse({ items: [] })
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response
    })
    render(<DatasetsManagePage />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  describe('filter debounce', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should filter by name after debounce', async () => {
      setupDefaultMocks()
      render(<DatasetsManagePage />)

      await waitFor(() => {
        expect(screen.getByText('population-data')).toBeInTheDocument()
      })

      // Clear call history after initial load
      vi.mocked(clientFetch).mockClear()
      setupDefaultMocks()

      const nameInput = screen.getByPlaceholderText('name...')
      fireEvent.change(nameInput, { target: { value: 'pop' } })

      // Before debounce — no new packages call
      const callsBefore = vi
        .mocked(clientFetch)
        .mock.calls.filter((c) => (c[0] as string).includes('/api/v1/packages'))
      expect(callsBefore).toHaveLength(0)

      // After debounce
      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      await waitFor(() => {
        const packagesCall = vi
          .mocked(clientFetch)
          .mock.calls.find((c) => (c[0] as string).includes('/api/v1/packages'))
        expect(packagesCall).toBeDefined()
        expect(packagesCall![0]).toContain('name=pop')
      })
    })

    it('should filter by keyword after debounce', async () => {
      setupDefaultMocks()
      render(<DatasetsManagePage />)

      await waitFor(() => {
        expect(screen.getByText('population-data')).toBeInTheDocument()
      })

      vi.mocked(clientFetch).mockClear()
      setupDefaultMocks()

      const keywordInput = screen.getByPlaceholderText('Search datasets...')
      fireEvent.change(keywordInput, { target: { value: 'budget' } })

      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      await waitFor(() => {
        const packagesCall = vi
          .mocked(clientFetch)
          .mock.calls.find((c) => (c[0] as string).includes('/api/v1/packages'))
        expect(packagesCall).toBeDefined()
        expect(packagesCall![0]).toContain('q=budget')
      })
    })
  })
})
