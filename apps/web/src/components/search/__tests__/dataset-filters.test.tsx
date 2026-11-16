import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { FacetCounts } from '@kukan/shared'
import { DatasetFilters } from '../dataset-filters'

const none: FacetCounts = {
  organizations: [],
  groups: [],
  tags: [],
  formats: [],
  licenses: [],
  areas: [],
  areaPlaces: [],
  meanings: [],
}

describe('DatasetFilters — vocabulary (ADR-073)', () => {
  it('shows neither filter where no table has a vocabulary', () => {
    render(<DatasetFilters baseParams={{}} facets={none} />)
    expect(screen.queryByText('Filter by area')).not.toBeInTheDocument()
    expect(screen.queryByText('Filter by column meaning')).not.toBeInTheDocument()
  })

  it('marks both filters experimental, and names nationwide and the meanings', () => {
    render(
      <DatasetFilters
        baseParams={{}}
        facets={{
          ...none,
          areas: [
            { name: '130001', title: '東京都', count: 2 },
            { name: '*', title: null, count: 1 },
          ],
          meanings: [{ name: 'admin-area:code', count: 2 }],
        }}
      />
    )
    expect(screen.getAllByRole('button', { name: 'Experimental' })).toHaveLength(2)
    expect(screen.getByText('東京都')).toBeInTheDocument()
    expect(screen.getByText('Nationwide')).toBeInTheDocument()
    expect(screen.getByText('Administrative area code')).toBeInTheDocument()
  })

  it('opens what "experimental" means on a tap, without folding the section', () => {
    render(
      <DatasetFilters
        baseParams={{}}
        facets={{ ...none, areas: [{ name: '130001', title: '東京都', count: 2 }] }}
      />
    )
    // happy-dom folds a <details> while the click is still bubbling, before
    // React sees it; a browser waits for the click to go uncancelled.
    let cancelled = false
    const seen = (e: Event) => (cancelled = e.defaultPrevented)
    document.addEventListener('click', seen)
    fireEvent.click(screen.getByRole('button', { name: 'Experimental' }))
    document.removeEventListener('click', seen)
    expect(screen.getByRole('dialog')).toHaveTextContent('experimental feature')
    expect(cancelled).toBe(true)
  })

  it('keeps a filter with a choice in it though nothing is counted now', () => {
    render(
      <DatasetFilters baseParams={{ area: '130001', meaning: 'admin-area:code' }} facets={none} />
    )
    expect(screen.getByText('Filter by area')).toBeInTheDocument()
    expect(screen.getByText('Filter by column meaning')).toBeInTheDocument()
  })

  it('takes the places chosen under an area away with it', () => {
    render(
      <DatasetFilters
        baseParams={{ area: ['130001', '270008'], area_place: ['131016', '271004'] }}
        facets={{
          ...none,
          areas: [
            { name: '130001', title: '東京都', count: 2 },
            { name: '270008', title: '大阪府', count: 1 },
          ],
          areaPlaces: [
            { name: '131016', title: '千代田区', count: 1, parent: '130001' },
            { name: '271004', title: '大阪市', count: 1, parent: '270008' },
          ],
        }}
      />
    )
    // Each area's places sit in its own entry, not after every area
    const entryOf = (text: string) =>
      screen.getByText(text).closest('li')!.parentElement!.closest('li')
    expect(entryOf('千代田区')).toHaveTextContent('東京都')
    expect(entryOf('大阪市')).toHaveTextContent('大阪府')
    expect(entryOf('千代田区')).not.toHaveTextContent('大阪府')
    // Tokyo's link drops Tokyo and Chiyoda, and keeps Osaka and its city
    expect(screen.getByText('東京都').closest('a')).toHaveAttribute(
      'href',
      '/dataset?area=270008&area_place=271004'
    )
    expect(screen.getByText('千代田区').closest('a')).toHaveAttribute(
      'href',
      '/dataset?area=130001&area=270008&area_place=271004'
    )
  })
})
