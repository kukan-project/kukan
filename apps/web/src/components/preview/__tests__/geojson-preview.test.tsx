import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ResourceSchema } from '@kukan/shared'
import { GeoJsonPreview } from '../geojson-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

// The map itself is Leaflet; stand in for it with what it was given
vi.mock('next/dynamic', () => ({
  default: () =>
    function GeoJsonMapStub({ data }: { data: GeoJSON.GeoJsonObject }) {
      return <div data-testid="geojson-map">{data.type}</div>
    },
}))

vi.mock('@/components/data-explorer/data-explorer', () => ({
  DataExplorer: ({
    resourceId,
    primaryKey,
    schemaColumns,
  }: {
    resourceId: string
    primaryKey?: string[] | null
    schemaColumns: { name: string }[]
  }) => (
    <div data-testid="data-explorer" data-pk={primaryKey?.join(',') ?? ''}>
      {resourceId}:{schemaColumns.map((c) => c.name).join(',')}
    </div>
  ),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

const featureCollection = { type: 'FeatureCollection', features: [] }
const schema = { columns: [{ name: 'city', type: 'VARCHAR' }] } as unknown as ResourceSchema

beforeEach(() => {
  mockClientFetch.mockReset()
})

describe('GeoJsonPreview', () => {
  it('draws the map, with no attribute tab where the interpretation made no table', async () => {
    mockClientFetch.mockResolvedValue(Response.json(featureCollection))
    render(<GeoJsonPreview resourceId="g1" />)

    expect(await screen.findByTestId('geojson-map')).toHaveTextContent('FeatureCollection')
    expect(screen.getByText('Map')).toBeInTheDocument()
    expect(screen.queryByText('Attributes')).not.toBeInTheDocument()
  })

  it('shows the file’s JSON on the JSON tab', async () => {
    mockClientFetch.mockResolvedValue(Response.json(featureCollection))
    const { container } = render(<GeoJsonPreview resourceId="g1" />)
    await screen.findByTestId('geojson-map')

    fireEvent.click(screen.getByText('JSON'))

    expect(screen.queryByTestId('geojson-map')).not.toBeInTheDocument()
    expect(container.querySelector('pre')!.textContent).toBe(
      JSON.stringify(featureCollection, null, 2)
    )
  })

  it('shows only the too-large message, with no tabs, when the file cannot be drawn and has no table', async () => {
    mockClientFetch.mockResolvedValue(new Response(null, { status: 413 }))
    render(<GeoJsonPreview resourceId="g1" />)

    expect(await screen.findByText(/too large for JSON preview/)).toBeInTheDocument()
    expect(screen.queryByText('Map')).not.toBeInTheDocument()
  })

  it('keeps the attribute table reachable when the file failed to load', async () => {
    mockClientFetch.mockRejectedValue(new Error('offline'))
    render(<GeoJsonPreview resourceId="g1" schema={schema} primaryKey={['city']} />)

    // The map tab stands in with the error rather than a map
    expect(await screen.findByText('Failed to load preview')).toBeInTheDocument()
    expect(screen.queryByTestId('geojson-map')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Attributes'))
    const table = screen.getByTestId('data-explorer')
    expect(table).toHaveTextContent('g1:city')
    expect(table).toHaveAttribute('data-pk', 'city')

    fireEvent.click(screen.getByText('JSON'))
    expect(screen.getByText('Failed to load preview')).toBeInTheDocument()
    expect(document.querySelector('pre')).toBeNull()
  })
})
