import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { SemanticSearchCard } from '../semantic-search-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response

const vector = {
  enabled: true,
  model: 'cohere.embed-v4:0',
  semanticEnabled: true,
  baseMinSimilarity: 0.3,
  baseSource: 'model',
  notches: 0,
  step: 0.025,
  maxNotches: 2,
  effectiveMinSimilarity: 0.3,
}

function settings(model: string | null) {
  mockClientFetch.mockImplementation(async (path: string) =>
    path === '/api/v1/admin/settings/vector-search'
      ? ok(model ? { ...vector, model } : { ...vector, enabled: false, model: null })
      : ok({})
  )
}

describe('SemanticSearchCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the model, and regenerates with it', async () => {
    settings('cohere.embed-v4:0')
    render(<SemanticSearchCard />)

    expect(await screen.findByText('cohere.embed-v4:0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Embedding regeneration queued')
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/reindex-embeddings', {
      method: 'POST',
    })
  })

  it('saves the threshold, and shows the value the server now applies', async () => {
    let notches = 0
    mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/admin/settings/vector-search') {
        return ok({ ...vector, notches, effectiveMinSimilarity: 0.3 + notches * 0.025 })
      }
      if (path === '/api/v1/admin/settings/vector-similarity-notches') {
        notches = JSON.parse(String(init?.body)).value
      }
      return ok({})
    })
    render(<SemanticSearchCard />)

    expect(await screen.findByText('Current effective value: 0.3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /0\.35/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Current effective value: 0.35')).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledWith(
      '/api/v1/admin/settings/vector-similarity-notches',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 2 }) })
    )
    // Only what changed is written
    expect(mockClientFetch).not.toHaveBeenCalledWith(
      '/api/v1/admin/settings/semantic-search-enabled',
      expect.anything()
    )
  })

  it('cannot regenerate without an embedding model', async () => {
    settings(null)
    render(<SemanticSearchCard />)

    expect(
      await screen.findByText('Embedding is not configured, so this cannot run.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
    // Nothing to tune either
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('says so when the settings cannot be read', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    render(<SemanticSearchCard />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the embedding settings.'
    )
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
  })

  it('says so when the regeneration cannot be queued', async () => {
    settings('cohere.embed-v4:0')
    render(<SemanticSearchCard />)
    await screen.findByText('cohere.embed-v4:0')
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled()
  })
})
