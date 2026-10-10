import { describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AdminAiPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(async (path: string) => ({
    ok: true,
    json: async () => (path === '/api/v1/admin/settings/ai-suggest' ? { provider: 'bedrock' } : {}),
  })),
}))

vi.mock('@/components/dashboard/ai/summary-generation-card', () => ({
  SummaryGenerationCard: () => <section>abstracts</section>,
}))
vi.mock('@/components/dashboard/ai/semantic-search-card', () => ({
  // Reports itself running, as it does once regeneration is queued
  SemanticSearchCard: ({ onRunningChange }: { onRunningChange?: (running: boolean) => void }) => {
    useEffect(() => onRunningChange?.(true), [onRunningChange])
    return <section>semantic search</section>
  },
}))
vi.mock('@/components/dashboard/ai/ai-suggest-card', () => ({
  AiSuggestCard: () => <section>suggestions</section>,
}))
vi.mock('@/components/dashboard/ai/ai-usage-card', () => ({
  AiUsageCard: ({ following }: { following?: boolean }) => (
    <section data-following={String(Boolean(following))}>usage</section>
  ),
}))

describe('AdminAiPage', () => {
  it('puts what AI consumed first, then a card per use', () => {
    const { container } = render(<AdminAiPage />)

    expect(screen.getByText('AI Management')).toBeInTheDocument()
    expect([...container.querySelectorAll('section')].map((s) => s.textContent)).toEqual([
      'usage',
      'abstracts',
      'suggestions',
      'semantic search',
    ])
  })

  it('has the usage follow a bulk action another card is running', async () => {
    render(<AdminAiPage />)

    await waitFor(() => expect(screen.getByText('usage')).toHaveAttribute('data-following', 'true'))
  })

  it('names the provider once, for every card below it', async () => {
    // React reports invalid nesting (a badge's <div> inside a <p>) only here
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AdminAiPage />)

    expect(await screen.findByText('bedrock')).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
    expect(screen.getByText('Provider:')).toBeInTheDocument()
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/admin/settings/ai-suggest', expect.anything())
  })
})
