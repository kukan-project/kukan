import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import DatasetsManagePage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
    mockPush.mockClear()
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
      expect(screen.getByText('population-data')).toBeInTheDocument()
    })
    // Default tab is "public", so all badges show "Public"
    // "Public" text appears in both the tab trigger and the badge(s)
    const publicElements = screen.getAllByText('Public')
    expect(publicElements.length).toBeGreaterThanOrEqual(2) // tab + badge(s)
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

    // Filter text inputs + select triggers
    const textboxes = screen.getAllByRole('textbox')
    expect(textboxes.length).toBe(2)
    const comboboxes = screen.getAllByRole('combobox')
    expect(comboboxes.length).toBe(2)
  })

  it('navigates to the edit page on row click', async () => {
    setupDefaultMocks()
    render(<DatasetsManagePage />)

    await waitFor(() => expect(screen.getByText('population-data')).toBeInTheDocument())
    fireEvent.click(screen.getByText('population-data'))
    expect(mockPush).toHaveBeenCalledWith('/dashboard/datasets/population-data/edit')
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

  describe('drafts tab', () => {
    const draftItems = [
      {
        id: 'd1',
        name: 'untitled-0123abcd',
        title: null,
        private: false,
        updated: '2026-07-01T00:00:00Z',
      },
      {
        id: 'd2',
        name: 'my-draft',
        title: 'My Draft',
        private: false,
        updated: '2026-07-02T00:00:00Z',
      },
      // A draft whose deletion crashed mid-flight (ADR-039)
      {
        id: 'd3',
        name: 'stuck-draft',
        title: 'Stuck Draft',
        private: false,
        updated: '2026-07-03T00:00:00Z',
        state: 'purging',
      },
    ]

    function setupDraftMocks() {
      vi.mocked(clientFetch).mockImplementation(async (path: string, init?: RequestInit) => {
        if (path.includes('/api/v1/organizations')) return mockFetchResponse({ items: [] })
        if (path.includes('/api/v1/groups')) return mockFetchResponse({ items: [] })
        if (init?.method === 'DELETE') return mockFetchResponse({})
        if (path.includes('state=draft'))
          return mockFetchResponse({ items: draftItems, total: draftItems.length })
        return mockFetchResponse({ items: sampleItems, total: sampleItems.length })
      })
    }

    async function openDraftsTab() {
      render(<DatasetsManagePage />)
      await waitFor(() => {
        expect(screen.getByText('Drafts')).toBeInTheDocument()
      })
      fireEvent.click(screen.getByText('Drafts'))
      await waitFor(() => {
        expect(screen.getByText('My Draft')).toBeInTheDocument()
      })
    }

    it('should list drafts with untitled fallback and hidden placeholder name', async () => {
      setupDraftMocks()
      await openDraftsTab()

      expect(screen.getByText('Untitled')).toBeInTheDocument()
      expect(screen.queryByText('untitled-0123abcd')).not.toBeInTheDocument()
      expect(screen.getByText('my-draft')).toBeInTheDocument()
    })

    it('should not send unsupported filters to the draft listing', async () => {
      setupDraftMocks()
      await openDraftsTab()

      const draftCalls = vi
        .mocked(clientFetch)
        .mock.calls.map((c) => c[0] as string)
        .filter((u) => u.includes('state=draft'))
      expect(draftCalls.length).toBeGreaterThan(0)
      for (const url of draftCalls) {
        expect(url).not.toContain('my_org')
        expect(url).not.toContain('groups')
      }
    })

    it('navigates to the draft edit page on row click', async () => {
      setupDraftMocks()
      await openDraftsTab()

      fireEvent.click(screen.getByText('My Draft'))
      expect(mockPush).toHaveBeenCalledWith('/dashboard/datasets/d2/edit?state=draft')
    })

    it('flags purging drafts and does not make their row clickable', async () => {
      setupDraftMocks()
      await openDraftsTab()

      expect(screen.getByText('Deletion incomplete')).toBeInTheDocument()
      expect(screen.getByText('Retry Delete')).toBeInTheDocument()
      // A purging draft's row is not clickable — clicking it must not navigate
      fireEvent.click(screen.getByText('Stuck Draft'))
      expect(mockPush).not.toHaveBeenCalled()
      // An intact draft still navigates on row click
      fireEvent.click(screen.getByText('My Draft'))
      expect(mockPush).toHaveBeenCalledWith('/dashboard/datasets/d2/edit?state=draft')
    })

    it('should retry deletion of a purging draft with a dedicated confirmation', async () => {
      setupDraftMocks()
      await openDraftsTab()

      fireEvent.click(screen.getByText('Retry Delete'))
      await waitFor(() => {
        expect(
          screen.getByText(
            'The previous deletion did not complete. Retrying will permanently delete this draft and all its resources.'
          )
        ).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Purge Dataset' }))

      await waitFor(() => {
        expect(vi.mocked(clientFetch)).toHaveBeenCalledWith('/api/v1/packages/d3', {
          method: 'DELETE',
        })
      })
    })

    it('should delete a draft after confirmation', async () => {
      setupDraftMocks()
      await openDraftsTab()

      fireEvent.click(screen.getAllByText('Delete')[1])
      await waitFor(() => {
        expect(
          screen.getByText(
            'This draft and all its resources will be permanently deleted. This cannot be undone.'
          )
        ).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Purge Dataset' }))

      await waitFor(() => {
        expect(vi.mocked(clientFetch)).toHaveBeenCalledWith('/api/v1/packages/d2', {
          method: 'DELETE',
        })
      })
    })
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

      const nameInput = screen.getAllByRole('textbox')[0]
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

      const keywordInput = screen.getAllByRole('textbox')[1]
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
