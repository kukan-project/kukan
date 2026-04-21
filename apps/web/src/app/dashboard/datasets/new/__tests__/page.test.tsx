import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/dataset/dataset-form', () => ({
  DatasetForm: ({ mode, organizations }: { mode: string; organizations: unknown[] }) => (
    <div data-testid="dataset-form" data-mode={mode}>
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
  })

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
})
