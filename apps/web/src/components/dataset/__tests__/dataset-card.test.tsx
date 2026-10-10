import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DatasetCard, type DatasetCardItem } from '../dataset-card'

vi.mock('@/lib/format-colors', () => ({
  getFormatColorClass: () => 'text-white bg-blue-500',
}))

vi.mock('@/lib/parse-groups', () => ({
  parseGroups: (groups: string) =>
    groups
      .split(',')
      .filter(Boolean)
      .map((g: string) => {
        const [name, ...rest] = g.split(':')
        return { name, title: rest.join(':') || name }
      }),
}))

describe('DatasetCard', () => {
  const basePkg: DatasetCardItem = {
    id: 'pkg-1',
    name: 'test-dataset',
    title: 'Test Dataset Title',
    notes: 'A description of the dataset.',
  }

  it('should render dataset title as link', () => {
    render(<DatasetCard pkg={basePkg} />)
    const link = screen.getByRole('link', { name: 'Test Dataset Title' })
    expect(link).toHaveAttribute('href', '/dataset/test-dataset')
  })

  it('should render name when no title', () => {
    render(<DatasetCard pkg={{ ...basePkg, title: null }} />)
    expect(screen.getByRole('link', { name: 'test-dataset' })).toBeInTheDocument()
  })

  it('should render organization name', () => {
    render(<DatasetCard pkg={{ ...basePkg, orgName: 'my-org', orgTitle: 'My Organization' }} />)
    expect(screen.getByText('My Organization')).toBeInTheDocument()
  })

  it('should render format badges', () => {
    render(<DatasetCard pkg={{ ...basePkg, formats: 'CSV,JSON' }} />)
    expect(screen.getByText('CSV')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
  })

  it('should render description', () => {
    render(<DatasetCard pkg={basePkg} />)
    expect(screen.getByText('A description of the dataset.')).toBeInTheDocument()
  })

  it('should render resource count', () => {
    render(<DatasetCard pkg={{ ...basePkg, resourceCount: 5 }} />)
    expect(screen.getByText('All 5 resources')).toBeInTheDocument()
  })

  it('should render updated and created dates', () => {
    render(
      <DatasetCard
        pkg={{ ...basePkg, updated: '2026-06-18T00:00:00Z', created: '2026-01-02T00:00:00Z' }}
      />
    )
    expect(screen.getByText(/Modified/)).toBeInTheDocument()
    expect(screen.getByText(/Created/)).toBeInTheDocument()
  })

  it('should render the machine name alongside the title', () => {
    render(<DatasetCard pkg={basePkg} />)
    // title is the link label; the slug (pkg.name) is shown as a separate mono span
    expect(screen.getByText('test-dataset')).toBeInTheDocument()
  })

  it('should render groups', () => {
    render(<DatasetCard pkg={{ ...basePkg, groups: 'env:Environment,health:Health' }} />)
    expect(screen.getByText('Environment')).toBeInTheDocument()
    expect(screen.getByText('Health')).toBeInTheDocument()
  })

  it('should render matched resources with links', () => {
    render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [
            { id: 'r1', name: 'Resource One', format: 'CSV', matchSource: 'metadata' },
          ],
        }}
      />
    )
    expect(screen.getByText('Resource One')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Resource One/ })
    expect(link).toHaveAttribute('href', '/dataset/test-dataset/resource/r1')
  })

  it('should name the section a matched resource sits in, marked when it is the match', () => {
    const { rerender } = render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [{ id: 'r1', name: 'first.pdf', section: '2024/minutes' }],
        }}
      />
    )
    expect(screen.getByText('2024 › minutes')).toBeInTheDocument()

    rerender(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [
            {
              id: 'r1',
              name: 'first.pdf',
              section: 'minutes',
              highlightedSection: '<mark>minutes</mark>',
            },
          ],
        }}
      />
    )
    expect(screen.getByText('minutes').tagName).toBe('MARK')
  })

  it('should fold a run matched on its section alone into one row, and cap the rest', () => {
    const inMinutes = (i: number) => ({
      id: `m${i}`,
      name: `meeting-${i}.pdf`,
      section: 'minutes',
      highlightedSection: '<mark>minutes</mark>',
      matchedOn: ['section' as const],
    })
    const byName = (i: number) => ({
      id: `n${i}`,
      name: `notes-${i}.txt`,
      highlightedName: `<mark>notes</mark>-${i}.txt`,
      matchedOn: ['name' as const],
    })
    render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [
            ...Array.from({ length: 30 }, (_, i) => inMinutes(i)),
            ...Array.from({ length: 7 }, (_, i) => byName(i)),
          ],
        }}
      />
    )
    // The thirty files under "minutes" are one hit: the first stands for them
    expect(screen.getByText('meeting-0.pdf')).toBeInTheDocument()
    expect(screen.queryByText('meeting-1.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('+29 more')).toBeInTheDocument()
    // Five rows are drawn; the other three name matches fold into a count
    expect(screen.getAllByRole('link', { name: /pdf|txt/ })).toHaveLength(5)
    expect(screen.getByText('and 3 more')).toBeInTheDocument()
  })

  it('should show every count as a floor when the search could only give one', () => {
    render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [
            { id: 'm1', name: 'a.pdf', section: 'minutes', matchedOn: ['section'] },
            { id: 'm2', name: 'b.pdf', section: 'minutes', matchedOn: ['section'] },
            ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, name: `n${i}.txt` })),
          ],
          matchedResourcesCount: { total: 12, atLeast: true },
        }}
      />
    )
    // One folded row (1 more) and four named rows are drawn; two rows and four uncarried hide
    expect(screen.getByText('1+ more')).toBeInTheDocument()
    expect(screen.getByText('and 6+ more')).toBeInTheDocument()
  })

  it('should render a semantic badge for vector-only hits', () => {
    render(<DatasetCard pkg={{ ...basePkg, matchSource: 'semantic' }} />)
    expect(screen.getByText('Semantic match')).toBeInTheDocument()
  })

  it('should not render a semantic badge for keyword hits', () => {
    render(<DatasetCard pkg={basePkg} />)
    expect(screen.queryByText('Semantic match')).not.toBeInTheDocument()
  })

  it('should show loading spinner when content match has no snippets yet', () => {
    render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [{ id: 'r1', name: 'data.csv', matchSource: 'content' }],
        }}
      />
    )
    expect(screen.getByText('Content match')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('should show content snippets when loaded', () => {
    render(
      <DatasetCard
        pkg={{
          ...basePkg,
          matchedResources: [
            {
              id: 'r1',
              name: 'data.csv',
              matchSource: 'content',
              contentSnippets: ['matched <mark>text</mark> here'],
            },
          ],
        }}
      />
    )
    expect(screen.getByText('Content match')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(screen.getByText(/matched/)).toBeInTheDocument()
  })
})
