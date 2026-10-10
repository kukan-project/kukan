import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { ContentChunkNotice } from '../content-chunk-notice'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const sysadmin = { id: 'u1', email: 'a@example.com', name: 'admin', sysadmin: true }
const viewer = { ...sysadmin, sysadmin: false }
let user = sysadmin

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => user,
}))

function mockStatus(body: unknown) {
  vi.mocked(clientFetch).mockResolvedValue({ ok: true, json: async () => body } as Response)
}

describe('ContentChunkNotice', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    user = sysadmin
  })

  it('prompts while resources hold content in larger chunks', async () => {
    mockStatus({ resources: 60 })

    render(<ContentChunkNotice />)

    expect(await screen.findByRole('button')).toBeInTheDocument()
    expect(screen.getByText(/60/)).toBeInTheDocument()
  })

  it('stays out of the way once every resource is rebuilt', async () => {
    mockStatus({ resources: 0 })

    render(<ContentChunkNotice />)

    await waitFor(() => expect(clientFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('asks for the rebuild with the content indexed again', async () => {
    mockStatus({ resources: 3 })

    render(<ContentChunkNotice />)
    fireEvent.click(await screen.findByRole('button'))

    await waitFor(() =>
      expect(clientFetch).toHaveBeenCalledWith('/api/v1/admin/reindex-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reindexContent: true }),
      })
    )
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })

  it('is not shown to anyone but a sysadmin', () => {
    user = viewer

    render(<ContentChunkNotice />)

    expect(clientFetch).not.toHaveBeenCalled()
  })
})
