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
})
