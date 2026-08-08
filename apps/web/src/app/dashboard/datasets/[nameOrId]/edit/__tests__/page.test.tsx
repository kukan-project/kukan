import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// Override the setup.ts navigation mock: these tests need to control the
// ?state= query and observe router.replace. The router object must be stable
// across renders (like the real one) — it is a useCallback dependency
const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  search: '',
}))
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => ({ nameOrId: 'test-entity' }),
}))

vi.mock('@/components/dashboard/dataset/dataset-form', () => ({
  // Publishing now happens inside the form ("Save & Publish") — surface the
  // onPublished callback so the page-level flow can be exercised, and the
  // suggest.processing flag for the AI-suggest gating tests
  DatasetForm: ({
    onPublished,
    suggest,
  }: {
    onPublished?: () => void
    suggest?: { processing?: boolean }
  }) => (
    <div data-testid="dataset-form">
      DatasetForm
      {suggest && <span data-testid="suggest-processing">{String(suggest.processing)}</span>}
      {onPublished && (
        <button type="button" onClick={onPublished}>
          MockPublish
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/dashboard/dataset/resource-list', () => ({
  ResourceList: ({
    onUpdated,
    onUploadingChange,
  }: {
    onUpdated?: () => void
    onUploadingChange?: (uploading: boolean) => void
  }) => (
    <div data-testid="resource-list">
      ResourceList
      <button type="button" onClick={() => onUpdated?.()}>
        MockSettle
      </button>
      <button type="button" onClick={() => onUploadingChange?.(true)}>
        MockUploadStart
      </button>
      <button type="button" onClick={() => onUploadingChange?.(false)}>
        MockUploadEnd
      </button>
    </div>
  ),
}))

vi.mock('@/components/dashboard/delete-confirm-dialog', () => ({
  DeleteConfirmDialog: () => <div data-testid="delete-confirm-dialog">DeleteConfirmDialog</div>,
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const samplePackage = {
  id: 'pkg-1',
  name: 'test-dataset',
  title: 'Test Dataset',
  notes: 'A test dataset',
  private: false,
  state: 'active',
  ownerOrg: 'org-1',
  licenseId: 'cc-by',
  resources: [{ id: 'r1', name: 'Resource 1', format: 'csv' }],
  tags: [{ id: 't1', name: 'tag1' }],
}

const sampleDraft = {
  ...samplePackage,
  state: 'draft',
}

const sampleOrgs = {
  items: [
    { id: 'org-1', name: 'org-one', title: 'Org One' },
    { id: 'org-2', name: 'org-two', title: 'Org Two' },
  ],
}

import EditDatasetPage from '../page'

describe('EditDatasetPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    nav.router.replace.mockReset()
    nav.search = ''
  })

  it('should render page title', () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}))
    render(<EditDatasetPage />)
    expect(screen.getByText('Edit Dataset')).toBeInTheDocument()
  })

  it('should show loading state initially', () => {
    mockClientFetch.mockReturnValue(new Promise(() => {}))
    render(<EditDatasetPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('should fetch dataset and organizations on mount', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(samplePackage))
      .mockResolvedValueOnce(jsonResponse(sampleOrgs))
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/packages/test-entity')
      // Org options come through useFetch, which passes an abort signal
      expect(mockClientFetch).toHaveBeenCalledWith(
        '/api/v1/users/me/organizations',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    })
  })

  it('should render DatasetForm and ResourceList after data loads', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(samplePackage))
      .mockResolvedValueOnce(jsonResponse(sampleOrgs))
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByTestId('dataset-form')).toBeInTheDocument()
    })
    expect(screen.getByTestId('resource-list')).toBeInTheDocument()
  })

  it('should link to the public page in a new tab (kukan#286)', async () => {
    mockClientFetch.mockImplementation(async (path: string) =>
      jsonResponse(path.includes('/users/me/organizations') ? sampleOrgs : samplePackage)
    )
    render(<EditDatasetPage />)

    const view = await screen.findByRole('link', { name: 'View' })
    expect(view).toHaveAttribute('href', '/dataset/test-dataset')
    expect(view).toHaveAttribute('target', '_blank')
  })

  it('should offer no public page for a draft', async () => {
    mockClientFetch.mockImplementation(async (path: string) =>
      jsonResponse(path.includes('/users/me/organizations') ? sampleOrgs : sampleDraft)
    )
    render(<EditDatasetPage />)

    await waitFor(() => expect(screen.getByTestId('dataset-form')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'View' })).not.toBeInTheDocument()
  })

  it('should have delete button', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(samplePackage))
      .mockResolvedValueOnce(jsonResponse(sampleOrgs))
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete This Dataset' })).toBeInTheDocument()
    })
  })

  it('should show not found when dataset fetch fails', async () => {
    mockClientFetch.mockImplementation(async (path: string) => {
      if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
      return jsonResponse(null, false)
    })
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByText('Dataset not found')).toBeInTheDocument()
    })
  })

  it('should retry as draft when the active fetch fails', async () => {
    mockClientFetch.mockImplementation(async (path: string) => {
      if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
      if (path.includes('state=draft')) return jsonResponse(sampleDraft)
      return jsonResponse(null, false)
    })
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByTestId('dataset-form')).toBeInTheDocument()
    })
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/packages/test-entity?state=draft')
  })

  describe('draft package', () => {
    function mockDraftFetch(draft: typeof sampleDraft) {
      mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (init?.method === 'POST') return jsonResponse({ ...draft, state: 'active' })
        return jsonResponse(draft)
      })
    }

    it('should show the draft badge and hand the publish callback to the form', async () => {
      mockDraftFetch(sampleDraft)
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByText('Draft')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: 'MockPublish' })).toBeInTheDocument()
    })

    it('should not hand the publish callback to the form for an active package', async () => {
      mockClientFetch.mockImplementation(async (path: string) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        return jsonResponse(samplePackage)
      })
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('dataset-form')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: 'MockPublish' })).not.toBeInTheDocument()
    })

    it('should show the success link and drop ?state=draft when the form publishes', async () => {
      mockDraftFetch(sampleDraft)
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'MockPublish' })).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: 'MockPublish' }))

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Dataset published.')
      })
      expect(screen.getByRole('link', { name: 'View public page' })).toHaveAttribute(
        'href',
        '/dataset/test-dataset'
      )
      expect(nav.router.replace).toHaveBeenCalledWith('/dashboard/datasets/test-entity/edit')
    })

    it('should fall back to active when ?state=draft 404s and offer a resync', async () => {
      // Publish committed on the server, but the page was reloaded with the
      // stale ?state=draft URL (e.g. after a publish-time search-sync failure)
      nav.search = 'state=draft'
      mockClientFetch.mockImplementation(async (path: string) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (path.includes('state=draft')) return jsonResponse(null, false)
        return jsonResponse(samplePackage)
      })
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(
          screen.getByText('Publishing has completed. Syncing to search may have failed.')
        ).toBeInTheDocument()
      })
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/packages/test-entity')
      expect(nav.router.replace).toHaveBeenCalledWith('/dashboard/datasets/test-entity/edit')
      // The package is active: no publish entry in the form, but the resync banner
      expect(screen.queryByRole('button', { name: 'MockPublish' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry sync' })).toBeEnabled()
    })

    it('should re-run publish from the resync banner and clear it on success', async () => {
      nav.search = 'state=draft'
      mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (init?.method === 'POST') return jsonResponse(samplePackage)
        if (path.includes('state=draft')) return jsonResponse(null, false)
        return jsonResponse(samplePackage)
      })
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Retry sync' })).toBeEnabled()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Retry sync' }))

      await waitFor(() => {
        expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/packages/test-entity/publish', {
          method: 'POST',
        })
      })
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Dataset published.')
      })
      expect(
        screen.queryByText('Publishing has completed. Syncing to search may have failed.')
      ).not.toBeInTheDocument()
    })

    it('should not resurrect the sync warning from a stale draft refetch after publish', async () => {
      nav.search = 'state=draft'
      let publishedNow = false
      mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (init?.method === 'POST') {
          publishedNow = true
          return jsonResponse({ ...sampleDraft, state: 'active' })
        }
        if (path.includes('state=draft'))
          return publishedNow ? jsonResponse(null, false) : jsonResponse(sampleDraft)
        return jsonResponse(samplePackage)
      })
      render(<EditDatasetPage />)
      fireEvent.click(await screen.findByRole('button', { name: 'MockPublish' }))
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Dataset published.')
      })

      // A refetch scheduled before publish fires with the stale ?state=draft
      // closure (the test router never updates the search params)
      fireEvent.click(screen.getByText('MockSettle'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(
        screen.queryByText('Publishing has completed. Syncing to search may have failed.')
      ).not.toBeInTheDocument()
    })

    it('should show draft delete wording', async () => {
      mockDraftFetch(sampleDraft)
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Delete Draft' })).toBeInTheDocument()
      })
      expect(
        screen.getByText(
          'This draft and all its resources will be permanently deleted. This cannot be undone.'
        )
      ).toBeInTheDocument()
    })
  })

  describe('AI-suggest nudge gating (ADR-040)', () => {
    const nudgeText = /Resource processing finished/

    // Path-keyed mock: the package response is re-evaluated on every refetch
    function mockPackageFetch(pkg: () => unknown) {
      const counter = { pkg: 0 }
      mockClientFetch.mockImplementation(async (path: string) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (path.includes('/site/settings')) return jsonResponse({ metadataSuggestEnabled: true })
        counter.pkg++
        return jsonResponse(pkg())
      })
      return counter
    }

    it('should not nudge when the page loads with everything already settled', async () => {
      mockPackageFetch(() => ({
        ...samplePackage,
        resources: [{ id: 'r1', name: 'r1', pipelineStatus: 'complete' }],
      }))
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('false')
      })
      expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()
    })

    it('should nudge only after every pipeline settled', async () => {
      let resources = [
        { id: 'r1', name: 'r1', pipelineStatus: 'complete' },
        { id: 'r2', name: 'r2', pipelineStatus: 'processing' },
      ]
      const counter = mockPackageFetch(() => ({ ...samplePackage, resources }))
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })

      // First pipeline settles while the second is still running — no nudge
      fireEvent.click(screen.getByText('MockSettle'))
      await waitFor(() => {
        expect(counter.pkg).toBe(2)
      })
      expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()

      resources = [
        { id: 'r1', name: 'r1', pipelineStatus: 'complete' },
        { id: 'r2', name: 'r2', pipelineStatus: 'complete' },
      ]
      fireEvent.click(screen.getByText('MockSettle'))
      await waitFor(() => {
        expect(screen.getByText(nudgeText)).toBeInTheDocument()
      })
      expect(screen.getByTestId('suggest-processing')).toHaveTextContent('false')
    })

    it('should nudge when a settle ended in error but another resource completed', async () => {
      let resources = [
        { id: 'r1', name: 'r1', pipelineStatus: 'complete' },
        { id: 'r2', name: 'r2', pipelineStatus: 'processing' },
      ]
      mockPackageFetch(() => ({ ...samplePackage, resources }))
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })

      resources = [
        { id: 'r1', name: 'r1', pipelineStatus: 'complete' },
        { id: 'r2', name: 'r2', pipelineStatus: 'error' },
      ]
      fireEvent.click(screen.getByText('MockSettle'))
      await waitFor(() => {
        expect(screen.getByText(nudgeText)).toBeInTheDocument()
      })
    })

    it('should not nudge when processing settled with errors only', async () => {
      // Without a complete resource the manual button stays disabled too, so
      // an invitation would have no working entry point
      let resources = [{ id: 'r1', name: 'r1', pipelineStatus: 'processing' }]
      mockPackageFetch(() => ({ ...samplePackage, resources }))
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })

      resources = [{ id: 'r1', name: 'r1', pipelineStatus: 'error' }]
      fireEvent.click(screen.getByText('MockSettle'))
      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('false')
      })
      expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()
    })

    it('should ignore a stale refetch that resolves after a newer one', async () => {
      const pkgWith = (status: string) => ({
        ...samplePackage,
        resources: [{ id: 'r1', name: 'r1', pipelineStatus: status }],
      })
      const pending: Array<(data: unknown) => void> = []
      mockClientFetch.mockImplementation(async (path: string) => {
        if (path.includes('/users/me/organizations')) return jsonResponse(sampleOrgs)
        if (path.includes('/site/settings')) return jsonResponse({ metadataSuggestEnabled: true })
        return new Promise<Response>((resolve) => {
          pending.push((data) => resolve(jsonResponse(data)))
        })
      })
      render(<EditDatasetPage />)
      await waitFor(() => expect(pending).toHaveLength(1))
      pending[0](pkgWith('processing'))
      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })

      // Two overlapping refetches; the newer resolves first with a running
      // pipeline, then the older tries to roll it back to complete
      fireEvent.click(screen.getByText('MockSettle'))
      fireEvent.click(screen.getByText('MockSettle'))
      await waitFor(() => expect(pending).toHaveLength(3))
      pending[2](pkgWith('queued'))
      pending[1](pkgWith('complete'))

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()
    })

    it('should close the gate after publish until the re-run pipelines settle', async () => {
      // Publish re-enqueues every url resource's pipeline before responding
      mockPackageFetch(() => ({
        ...samplePackage,
        state: 'draft',
        resources: [
          { id: 'r1', name: 'r1', url: 'https://example.com/a.csv', pipelineStatus: 'complete' },
        ],
      }))
      render(<EditDatasetPage />)
      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('false')
      })

      fireEvent.click(screen.getByRole('button', { name: 'MockPublish' }))
      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })
    })

    it('should retract a shown nudge when new work starts', async () => {
      // A lingering invitation could otherwise open the dialog (via the
      // open signal) and suggest without the resources still processing
      mockPackageFetch(() => ({
        ...samplePackage,
        resources: [{ id: 'r1', name: 'r1', pipelineStatus: 'complete' }],
      }))
      render(<EditDatasetPage />)
      await waitFor(() => {
        expect(screen.getByTestId('resource-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('MockUploadStart'))
      fireEvent.click(screen.getByText('MockUploadEnd'))
      await waitFor(() => {
        expect(screen.getByText(nudgeText)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('MockUploadStart'))
      await waitFor(() => {
        expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('MockUploadEnd'))
      await waitFor(() => {
        expect(screen.getByText(nudgeText)).toBeInTheDocument()
      })
    })

    it('should hold the nudge while an upload is still in flight', async () => {
      mockPackageFetch(() => ({
        ...samplePackage,
        resources: [{ id: 'r1', name: 'r1', pipelineStatus: 'complete' }],
      }))
      render(<EditDatasetPage />)

      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('false')
      })

      fireEvent.click(screen.getByText('MockUploadStart'))
      await waitFor(() => {
        expect(screen.getByTestId('suggest-processing')).toHaveTextContent('true')
      })
      expect(screen.queryByText(nudgeText)).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('MockUploadEnd'))
      await waitFor(() => {
        expect(screen.getByText(nudgeText)).toBeInTheDocument()
      })
    })
  })
})
