import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data, text: async () => '' } as Response
}

import ApiTokensPage from '../page'

describe('ApiTokensPage', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should render page title', () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<ApiTokensPage />)
    expect(screen.getByText('API Tokens')).toBeInTheDocument()
  })

  it('should show empty state when no tokens', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<ApiTokensPage />)
    await waitFor(() => {
      expect(screen.getByText('No API tokens')).toBeInTheDocument()
    })
  })

  it('should display token list', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 't1', name: 'My Token', lastUsed: null, expiresAt: null, created: '2026-01-01' },
        ],
      })
    )
    render(<ApiTokensPage />)
    await waitFor(() => {
      expect(screen.getByText('My Token')).toBeInTheDocument()
    })
  })

  it('should have new button', () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<ApiTokensPage />)
    expect(screen.getByText('New')).toBeInTheDocument()
  })

  it('should open create dialog on new button click', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ items: [] }))
    render(<ApiTokensPage />)

    fireEvent.click(screen.getByText('New'))

    await waitFor(() => {
      expect(screen.getByText('Create API Token')).toBeInTheDocument()
    })
  })

  it('should show delete button for each token', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 't1', name: 'Token A', lastUsed: null, expiresAt: null, created: '2026-01-01' },
        ],
      })
    )
    render(<ApiTokensPage />)
    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })
  })
})
