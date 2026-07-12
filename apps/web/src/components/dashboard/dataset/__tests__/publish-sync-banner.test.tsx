import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { PublishSyncBanner } from '../publish-sync-banner'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('PublishSyncBanner', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should show the sync warning with a resync button', () => {
    render(<PublishSyncBanner nameOrId="pkg-1" onPublished={vi.fn()} />)

    expect(
      screen.getByText('Publishing has completed. Syncing to search may have failed.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry sync' })).toBeInTheDocument()
  })

  it('should re-publish and call onPublished on success', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}))
    const onPublished = vi.fn()
    render(<PublishSyncBanner nameOrId="pkg-1" onPublished={onPublished} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry sync' }))

    await waitFor(() => {
      expect(onPublished).toHaveBeenCalled()
    })
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/packages/pkg-1/publish', {
      method: 'POST',
    })
  })

  it('should show the error detail when the resync fails', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({ detail: 'Search unavailable' }, false))
    const onPublished = vi.fn()
    render(<PublishSyncBanner nameOrId="pkg-1" onPublished={onPublished} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry sync' }))

    await waitFor(() => {
      expect(screen.getByText('Search unavailable')).toBeInTheDocument()
    })
    expect(onPublished).not.toHaveBeenCalled()
  })
})
