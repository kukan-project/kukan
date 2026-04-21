import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/dataset/dataset-form', () => ({
  DatasetForm: () => <div data-testid="dataset-form">DatasetForm</div>,
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
  ownerOrg: 'org-1',
  resources: [{ id: 'r1', name: 'Resource 1', format: 'csv' }],
  tags: [{ id: 't1', name: 'tag1' }],
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
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/users/me/organizations')
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
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(null, false))
      .mockResolvedValueOnce(jsonResponse(sampleOrgs))
    render(<EditDatasetPage />)

    await waitFor(() => {
      expect(screen.getByText('Dataset not found')).toBeInTheDocument()
    })
  })
})
