import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResourceExplorer, type Resource } from '../resource-explorer'

vi.mock('../resource-pipeline-preview', () => ({
  ResourcePipelinePreview: () => <div data-testid="pipeline-preview" />,
}))

vi.mock('../version-history', () => ({
  VersionHistory: () => <div data-testid="version-history" />,
}))

const baseResource: Resource = {
  id: 'r1',
  name: 'population.csv',
  format: 'CSV',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-02T00:00:00Z',
}

function renderExplorer(resource: Partial<Resource>) {
  return render(
    <ResourceExplorer resources={[{ ...baseResource, ...resource }]} packageName="population" />
  )
}

describe('ResourceExplorer', () => {
  it('links to the source site when the resource lives on an external URL', () => {
    renderExplorer({ url: 'https://example.com/data/population.csv', urlType: null })

    // Shortened to the host so a long path cannot push the layout around; the
    // whole URL is still what the link points at, and its tooltip.
    const link = screen.getByRole('link', { name: 'example.com/…' })
    expect(link).toHaveAttribute('href', 'https://example.com/data/population.csv')
    expect(link).toHaveAttribute('title', 'https://example.com/data/population.csv')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText(/Hosted on an external site/)).toBeInTheDocument()
  })

  it('shows the bare host when the URL has no path of its own', () => {
    renderExplorer({ url: 'https://example.com', urlType: null })

    expect(screen.getByRole('link', { name: 'example.com' })).toBeInTheDocument()
  })

  it('warns that the link may be gone when the last health check failed', () => {
    renderExplorer({
      url: 'https://example.com/data/population.csv',
      urlType: null,
      healthStatus: 'error',
      healthCheckedAt: '2026-09-06T01:00:00Z',
    })

    // The verdict and its date, and nothing about the status or error behind
    // it — neither is public.
    expect(screen.getByRole('button', { name: /may no longer work/i })).toBeInTheDocument()
  })

  it('says nothing about the link when the last health check passed', () => {
    renderExplorer({
      url: 'https://example.com/data/population.csv',
      urlType: null,
      healthStatus: 'ok',
      healthCheckedAt: '2026-09-06T01:00:00Z',
    })

    expect(screen.queryByRole('button', { name: /link check/i })).not.toBeInTheDocument()
  })

  it('says nothing about a source site for an uploaded file', () => {
    renderExplorer({ url: 'population.csv', urlType: 'upload' })

    expect(screen.queryByText(/Hosted on an external site/)).not.toBeInTheDocument()
  })
})

function ExplorerWithNames({ names }: { names: string[] }) {
  return (
    <ResourceExplorer
      packageName="population"
      resources={names.map((name, i) => ({ ...baseResource, id: `r${i}`, name }))}
    />
  )
}

describe('ResourceExplorer sections', () => {
  const rows: Resource[] = [
    { ...baseResource, id: 'r1', name: 'addresses.csv', section: null },
    { ...baseResource, id: 'r2', name: 'dictionary.pdf', section: 'docs' },
    { ...baseResource, id: 'r3', name: 'codes.csv', section: 'docs' },
    { ...baseResource, id: 'r4', name: 'facilities.csv', section: null },
    { ...baseResource, id: 'r5', name: 'readme.md', section: 'docs' },
  ]

  it('heads each run with its name, so a split section is headed twice', () => {
    render(<ResourceExplorer resources={rows} packageName="population" />)

    // The selected resource's title is an h3 too, so ask for the name
    expect(screen.getAllByRole('heading', { level: 3, name: 'docs' })).toHaveLength(2)
  })

  it('leaves the scrolling to the page, so the list has no scroll region of its own', () => {
    const { container } = render(<ResourceExplorer resources={rows} packageName="population" />)

    // A max-height here is measured from the top of the viewport, but the list
    // starts well below it, so its scroll region ran off the bottom of the screen
    expect(container.querySelector('.overflow-y-auto')).toBeNull()
  })

  it('indents a section member and not a root resource', () => {
    render(<ResourceExplorer resources={rows} packageName="population" />)

    // The list precedes the preview pane, whose title repeats the selected
    // name — so the first match is the card in the list
    const card = (name: string) => screen.getAllByText(name)[0].closest('[data-slot="card"]')
    expect(card('dictionary.pdf')).toHaveClass('ml-2')
    expect(card('addresses.csv')).not.toHaveClass('ml-2')
  })

  it('gives a resource name two lines, breaking a long file name across them', () => {
    render(<ResourceExplorer resources={rows} packageName="population" />)

    const name = screen.getAllByText('dictionary.pdf')[0]
    expect(name).toHaveClass('line-clamp-2')
    expect(name).toHaveClass('break-words')
  })

  it('holds two lines of height for every card, so a short name does not shrink it', () => {
    render(
      <ExplorerWithNames
        names={['short.csv', '業種別季節調整済指数（月次）（平成27年＝100）で長いほうの名前']}
      />
    )

    // jsdom has no layout, so the fixed two-line box is what can be asserted
    for (const name of ['short.csv', /業種別季節調整済指数/]) {
      const box = screen.getAllByText(name)[0].parentElement
      expect(box).toHaveClass('h-9')
      expect(box).toHaveClass('items-center')
    }
  })

  it('nests a sub-section under its parent, one heading level down', () => {
    render(
      <ResourceExplorer
        packageName="population"
        resources={[
          { ...baseResource, id: 'r1', name: 'a.csv', section: 'docs' },
          { ...baseResource, id: 'r2', name: 'b.csv', section: 'docs/raw' },
          { ...baseResource, id: 'r3', name: 'c.csv', section: 'docs/raw' },
          { ...baseResource, id: 'r4', name: 'd.csv', section: 'other' },
        ]}
      />
    )

    const level = (n: number) =>
      screen.getAllByRole('heading', { level: n }).map((h) => h.textContent)
    expect(level(3)).toEqual(expect.arrayContaining(['docs', 'other']))
    expect(level(4)).toEqual(['raw'])
    const card = (name: string) => screen.getAllByText(name)[0].closest('[data-slot="card"]')
    expect(card('b.csv')).toHaveClass('ml-4')
  })

  it('stops at three levels and shows the rest as one folded label', () => {
    render(
      <ResourceExplorer
        packageName="population"
        resources={[{ ...baseResource, id: 'r1', name: 'a.csv', section: 'a/b/c/d' }]}
      />
    )

    expect(screen.getByRole('heading', { level: 5, name: 'c/d' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 6 })).not.toBeInTheDocument()
    const card = screen.getAllByText('a.csv')[0].closest('[data-slot="card"]')
    expect(card).toHaveClass('ml-6')
  })

  it('names a parent that has no rows of its own, from its child path', () => {
    render(
      <ResourceExplorer
        packageName="population"
        resources={[{ ...baseResource, id: 'r1', name: 'a.csv', section: 'docs/raw' }]}
      />
    )

    expect(screen.getByRole('heading', { level: 3, name: 'docs' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 4, name: 'raw' })).toBeInTheDocument()
  })
})
