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
