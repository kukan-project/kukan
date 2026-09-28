import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminAiPage from '../page'

vi.mock('@/components/dashboard/summary-generation-card', () => ({
  SummaryGenerationCard: () => <section>abstracts</section>,
}))
vi.mock('@/components/dashboard/embedding-regenerate-card', () => ({
  EmbeddingRegenerateCard: () => <section>regenerate</section>,
}))

describe('AdminAiPage', () => {
  it('lists the embedding regeneration, then the abstracts', () => {
    const { container } = render(<AdminAiPage />)

    expect(screen.getByText('AI Management')).toBeInTheDocument()
    expect([...container.querySelectorAll('section')].map((s) => s.textContent)).toEqual([
      'regenerate',
      'abstracts',
    ])
  })
})
