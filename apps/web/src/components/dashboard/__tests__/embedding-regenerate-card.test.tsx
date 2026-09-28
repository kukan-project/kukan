import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { EmbeddingRegenerateCard } from '../embedding-regenerate-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response

function settings(model: string | null) {
  mockClientFetch.mockImplementation(async (path: string) =>
    path === '/api/v1/admin/settings/vector-search' ? ok({ model }) : ok({})
  )
}

describe('EmbeddingRegenerateCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the model, and regenerates with it', async () => {
    settings('cohere.embed-v4:0')
    render(<EmbeddingRegenerateCard />)

    expect(await screen.findByText('cohere.embed-v4:0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Embedding regeneration queued')
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/reindex-embeddings', {
      method: 'POST',
    })
  })

  it('cannot regenerate without an embedding model', async () => {
    settings(null)
    render(<EmbeddingRegenerateCard />)

    expect(
      await screen.findByText('Embedding is not configured, so this cannot run.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
  })

  it('says so when the settings cannot be read', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    render(<EmbeddingRegenerateCard />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the embedding settings.'
    )
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
  })

  it('says so when the regeneration cannot be queued', async () => {
    settings('cohere.embed-v4:0')
    render(<EmbeddingRegenerateCard />)
    await screen.findByText('cohere.embed-v4:0')
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled()
  })
})
