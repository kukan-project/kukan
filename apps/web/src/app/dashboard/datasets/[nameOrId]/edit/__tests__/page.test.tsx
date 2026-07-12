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
  // onPublished callback so the page-level flow can be exercised
  DatasetForm: ({ onPublished }: { onPublished?: () => void }) => (
    <div data-testid="dataset-form">
      DatasetForm
      {onPublished && (
        <button type="button" onClick={onPublished}>
          MockPublish
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/dashboard/dataset/resource-list', () => ({
  ResourceList: () => <div data-testid="resource-list">ResourceList</div>,
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

  it('should have delete button', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(samplePackage))
      .mockResolvedValueOnce(jsonResponse(sampleOrgs))
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Dataset' })).toBeInTheDocument()
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
        expect(screen.getByText('Dataset published.')).toBeInTheDocument()
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
        expect(screen.getByText('Dataset published.')).toBeInTheDocument()
      })
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
})
