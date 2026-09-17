import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { EmbeddingBackfillNotice } from '../embedding-backfill-notice'

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

describe('EmbeddingBackfillNotice', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    user = sysadmin
  })

  it('prompts while resources are outside semantic search', async () => {
    mockStatus({ missing: 12 })

    render(<EmbeddingBackfillNotice />)

    expect(await screen.findByRole('button')).toBeInTheDocument()
    expect(screen.getByText(/12/)).toBeInTheDocument()
  })

  it('stays out of the way once every resource is embedded', async () => {
    mockStatus({ missing: 0 })

    render(<EmbeddingBackfillNotice />)

    await waitFor(() => expect(clientFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('asks nothing of a viewer who could not act on the answer', async () => {
    user = viewer
    mockStatus({ missing: 12 })

    render(<EmbeddingBackfillNotice />)

    await waitFor(() => expect(clientFetch).not.toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
