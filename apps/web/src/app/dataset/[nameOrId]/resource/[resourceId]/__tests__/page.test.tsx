import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import ResourceDetailPage from '../page'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/components/dataset-detail-layout', () => ({
  DatasetDetailLayout: ({
    pkg,
    initialResourceId,
  }: {
    pkg: { id: string; name: string }
    initialResourceId?: string
  }) => (
    <div
      data-testid="dataset-detail-layout"
      data-pkg-id={pkg.id}
      data-resource-id={initialResourceId ?? ''}
    >
      {pkg.name}
    </div>
  ),
}))

function mockResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

const samplePkg = {
  id: 'pkg-1',
  name: 'population-data',
  title: 'Population Data',
  resources: [
    { id: 'r1', name: 'population.csv', format: 'CSV' },
    { id: 'r2', name: 'report.pdf', format: 'PDF' },
  ],
}

function makeParams(nameOrId: string, resourceId: string) {
  return { params: Promise.resolve({ nameOrId, resourceId }) }
}

describe('ResourceDetailPage', () => {
  beforeEach(() => {
    vi.mocked(serverFetch).mockReset()
    vi.mocked(notFound).mockClear()
  })

  it('should render DatasetDetailLayout with pkg and initialResourceId', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    const layout = screen.getByTestId('dataset-detail-layout')
    expect(layout).toHaveAttribute('data-pkg-id', 'pkg-1')
    expect(layout).toHaveAttribute('data-resource-id', 'r1')
  })

  it('should call notFound when package fetch fails', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'))

    await expect(ResourceDetailPage(makeParams('population-data', 'r1'))).rejects.toThrow(
      'NEXT_NOT_FOUND'
    )
    expect(notFound).toHaveBeenCalled()
  })

  it('should call notFound when package response is not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(null, false))

    await expect(ResourceDetailPage(makeParams('population-data', 'r1'))).rejects.toThrow(
      'NEXT_NOT_FOUND'
    )
    expect(notFound).toHaveBeenCalled()
  })

  it('should call notFound when resource is not in package', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))

    await expect(ResourceDetailPage(makeParams('population-data', 'nonexistent'))).rejects.toThrow(
      'NEXT_NOT_FOUND'
    )
    expect(notFound).toHaveBeenCalled()
  })

  it('should fetch package using nameOrId from params', async () => {
    vi.mocked(serverFetch).mockResolvedValue(mockResponse(samplePkg))
    const jsx = await ResourceDetailPage(makeParams('population-data', 'r1'))
    render(jsx)

    expect(serverFetch).toHaveBeenCalledWith('/api/v1/packages/population-data')
  })
})
