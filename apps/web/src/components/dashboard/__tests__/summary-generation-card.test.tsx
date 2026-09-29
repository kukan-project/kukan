import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { SummaryGenerationCard } from '../summary-generation-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const estimate = {
  model: 'test-model',
  locale: 'ja',
  fill: {
    resources: 12,
    estimatedInputTokens: { low: 1000, high: 4000 },
    estimatedOutputTokens: 600,
    estimatedCostUsd: { low: 0.1, high: 0.4 },
  },
  refresh: {
    resources: 0,
    estimatedInputTokens: { low: 0, high: 0 },
    estimatedOutputTokens: 0,
    estimatedCostUsd: null,
  },
  skipped: { tooLarge: 1, unsupportedFormat: 2, noMaterial: 0 },
}

function mockFetchResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

function mockRoutes(enabled = true) {
  vi.mocked(clientFetch).mockImplementation(async (path: string) => {
    if (path.includes('/site/settings')) {
      return mockFetchResponse({ resourceSummaryEnabled: enabled })
    }
    if (path.includes('/summary-estimate')) return mockFetchResponse(estimate)
    return mockFetchResponse({})
  })
}

describe('SummaryGenerationCard', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('shows nothing where the deployment writes no abstracts', async () => {
    mockRoutes(false)
    render(<SummaryGenerationCard />)

    await waitFor(() => {
      expect(clientFetch).toHaveBeenCalledWith('/api/v1/site/settings', expect.anything())
    })
    expect(screen.queryByText('Generate AI descriptions in bulk')).not.toBeInTheDocument()
    // The estimate costs a query of its own; nothing asks for it here
    expect(clientFetch).not.toHaveBeenCalledWith(
      '/api/v1/admin/summary-estimate',
      expect.anything()
    )
  })

  it('prices each generation before its own button', async () => {
    mockRoutes()
    render(<SummaryGenerationCard />)

    await waitFor(() => {
      expect(screen.getByText(/12 resources/)).toBeInTheDocument()
    })
    expect(screen.getByText(/\$0\.10/)).toBeInTheDocument()
    // Nothing to refresh, so nothing to spend on it
    expect(screen.getByRole('button', { name: /Rewrite all/ })).toBeDisabled()
  })

  it('queues the fill, and says so', async () => {
    mockRoutes()
    render(<SummaryGenerationCard />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Write the missing ones/ })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole('button', { name: /Write the missing ones/ }))

    await waitFor(() => {
      expect(clientFetch).toHaveBeenCalledWith(
        '/api/v1/admin/generate-summaries',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ refresh: false }) })
      )
    })
  })

  it('saves the language, then counts again what it leaves to rewrite', async () => {
    let saved = 'ja'
    vi.mocked(clientFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/site/settings')) {
        return mockFetchResponse({ resourceSummaryEnabled: true })
      }
      if (path === '/api/v1/admin/settings/ai-summary-locale') {
        saved = JSON.parse(String(init?.body)).value
        return mockFetchResponse({ key: 'ai-summary-locale', value: saved })
      }
      if (path.includes('/summary-estimate')) {
        // Every abstract was written in Japanese, so English leaves them all to rewrite
        return mockFetchResponse({
          ...estimate,
          locale: saved,
          refresh: { ...estimate.fill, resources: saved === 'en' ? 40 : 0 },
        })
      }
      return mockFetchResponse({})
    })
    render(<SummaryGenerationCard />)

    const picker = await screen.findByRole('combobox', { name: 'Language' })
    expect(picker).toHaveTextContent('Japanese')
    // Nothing picked, nothing to save
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.keyDown(picker, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(clientFetch).toHaveBeenCalledWith(
        '/api/v1/admin/settings/ai-summary-locale',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 'en' }) })
      )
    })
    expect(await screen.findByRole('status')).toHaveTextContent(/Saved/)
    // Asked again, the estimate prices the rewrite the new language calls for
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Rewrite all/ })).toBeEnabled()
    })
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English')
  })

  it('does not offer to spend on an estimate it could not read', async () => {
    vi.mocked(clientFetch).mockImplementation(async (path: string) =>
      path.includes('/site/settings')
        ? mockFetchResponse({ resourceSummaryEnabled: true })
        : mockFetchResponse({}, false)
    )
    render(<SummaryGenerationCard />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Write the missing ones/ })).toBeDisabled()
  })
})
