import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { SemanticState } from '@kukan/shared'
import { DatasetList } from '../dataset-list'

const mockSearchParams = vi.fn(() => new URLSearchParams('q=first'))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dataset',
  useSearchParams: () => mockSearchParams(),
}))

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ semanticSearchEnabled: true, searchExampleQueries: [] }),
}))

const mockClientFetch = vi.fn()
vi.mock('@/lib/client-api', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}))

/** An empty result page, carrying what the search did with the vector leg */
const page = (semantic: SemanticState) => ({
  ok: true,
  json: async () => ({ items: [], total: 0, offset: 0, limit: 20, semantic }),
})

const degradedNotice = () => screen.queryByText(/keyword matches only/i)

beforeEach(() => {
  mockSearchParams.mockReturnValue(new URLSearchParams('q=first'))
  mockClientFetch.mockReset()
})

describe('DatasetList', () => {
  it('should stop saying the vector leg dropped out once the next search starts', async () => {
    mockClientFetch.mockResolvedValueOnce(page('degraded'))
    const { rerender } = render(<DatasetList initialData={null} />)
    await waitFor(() => expect(degradedNotice()).toBeInTheDocument())

    // The next search is in flight: the notice describes the last one, and
    // this one may well succeed — say nothing until it answers
    let answer: (value: unknown) => void = () => {}
    mockClientFetch.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    mockSearchParams.mockReturnValue(new URLSearchParams('q=second'))
    rerender(<DatasetList initialData={null} />)

    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument())
    expect(degradedNotice()).not.toBeInTheDocument()

    // The count is the one thing only the answer can put on screen
    answer(page('applied'))
    await screen.findByText('0 items')
    expect(degradedNotice()).not.toBeInTheDocument()
  })

  // Nothing latches the notice today, and nothing should: it is a fact about
  // the last search, not a warning the reader dismisses once
  it('should say it again when the new search degrades too', async () => {
    mockClientFetch.mockResolvedValue(page('degraded'))
    const { rerender } = render(<DatasetList initialData={null} />)
    await waitFor(() => expect(degradedNotice()).toBeInTheDocument())

    mockSearchParams.mockReturnValue(new URLSearchParams('q=second'))
    rerender(<DatasetList initialData={null} />)
    await waitFor(() => expect(degradedNotice()).toBeInTheDocument())
  })

  it('marks an area by the code the answer read it as, and only for the search the URL still asks', async () => {
    const tokyo = {
      ok: true,
      json: async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 20,
        semantic: 'applied',
        facets: {
          organizations: [],
          groups: [],
          tags: [{ name: 'env', count: 1 }],
          formats: [],
          licenses: [],
          areas: [{ name: '130001', title: '東京都', count: 1 }],
          areaPlaces: [],
          meanings: [],
        },
        // `13` in the URL, read as Tokyo's code
        vocabularyFilters: { area: ['130001'], area_place: [] },
      }),
    }
    mockSearchParams.mockReturnValue(new URLSearchParams('area=13'))
    mockClientFetch.mockResolvedValueOnce(tokyo)
    const { rerender } = render(<DatasetList initialData={null} />)

    // Chosen, so its link takes it away
    const area = await screen.findByText('東京都')
    expect(area.closest('a')?.getAttribute('href')).toBe('/dataset?')

    // Tokyo taken away; the next answer is still on its way, and the links must
    // not bring Tokyo back from the last one
    mockClientFetch.mockReturnValueOnce(new Promise(() => {}))
    mockSearchParams.mockReturnValue(new URLSearchParams(''))
    rerender(<DatasetList initialData={null} />)
    await waitFor(() =>
      expect(screen.getByText('env').closest('a')?.getAttribute('href')).toBe('/dataset?tags=env')
    )
  })
})
