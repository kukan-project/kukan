import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
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

describe('SemanticSearchCard once regeneration is queued', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A second at a time until `check` passes, for at most `ms` */
  async function elapseUntil(ms: number, check: () => void) {
    for (let t = 0; ; t += 1_000) {
      try {
        return check()
      } catch (err) {
        if (t >= ms) throw err
      }
      await act(() => vi.advanceTimersByTimeAsync(1_000))
    }
  }

  it('follows what is left, holding the button back, and says when it is done', async () => {
    const left = [40, 12, 0]
    let reads = 0
    mockClientFetch.mockImplementation(async (path: string) => {
      if (path === '/api/v1/admin/settings/vector-search') return ok(vector)
      if (path === '/api/v1/admin/embedding-status') {
        const outstanding = left[Math.min(reads++, left.length - 1)]
        // `missing` leaves out what regeneration just marked: it is not what is followed
        return ok({ missing: 0, outstanding })
      }
      return ok({})
    })
    render(<SemanticSearchCard />)
    const button = await screen.findByRole('button', { name: 'Regenerate' })
    // Nothing about the embeddings is read before the press
    expect(mockClientFetch).not.toHaveBeenCalledWith('/api/v1/admin/embedding-status')

    fireEvent.click(button)
    expect(await screen.findByText('Regenerating embeddings: 40 left')).toBeInTheDocument()
    expect(button).toBeDisabled()

    await elapseUntil(20_000, () =>
      expect(screen.getByText('Regenerating embeddings: 12 left')).toBeInTheDocument()
    )
    await elapseUntil(20_000, () =>
      expect(screen.getByText('Embedding regeneration is done.')).toBeInTheDocument()
    )
    expect(button).toBeEnabled()
    const after = reads
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(reads).toBe(after)
  })
})
