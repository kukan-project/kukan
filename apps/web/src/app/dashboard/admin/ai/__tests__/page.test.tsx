import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import AdminAiPage from '../page'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(async (path: string) => ({
    ok: true,
    json: async () => (path === '/api/v1/admin/settings/ai-suggest' ? { provider: 'bedrock' } : {}),
  })),
}))

vi.mock('@/components/dashboard/summary-generation-card', () => ({
  SummaryGenerationCard: () => <section>abstracts</section>,
}))
vi.mock('@/components/dashboard/semantic-search-card', () => ({
  SemanticSearchCard: () => <section>semantic search</section>,
}))
vi.mock('@/components/dashboard/ai-suggest-card', () => ({
  AiSuggestCard: () => <section>suggestions</section>,
}))

describe('AdminAiPage', () => {
  it('groups the cards by the AI use they serve', () => {
    const { container } = render(<AdminAiPage />)

    expect(screen.getByText('AI Management')).toBeInTheDocument()
    expect([...container.querySelectorAll('section')].map((s) => s.textContent)).toEqual([
      'semantic search',
      'abstracts',
      'suggestions',
    ])
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
