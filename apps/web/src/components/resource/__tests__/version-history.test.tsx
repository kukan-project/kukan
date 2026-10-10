import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { VersionView } from '@kukan/shared'
import { VersionHistory } from '../version-history'

const mockClientFetch = vi.fn()

vi.mock('@/lib/client-api', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}))

function makeVersion(overrides: Partial<VersionView> = {}): VersionView {
  return {
    version: 1,
    origin: 'upload',
    state: 'active',
    isLive: false,
    purgeFallsBackTo: null,
    format: 'csv',
    keyColumns: null,
    size: 1024,
    hash: 'sha256:abc',
    schema: null,
    noTableReason: null,
    restoredFrom: null,
    created: '2026-08-01T00:00:00.000Z',
    purgedAt: null,
    ...overrides,
  }
}

function mockVersions(versions: VersionView[]) {
  mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({ versions }) })
}

/** jsdom does not toggle <details> from a summary click, so open it directly. */
function openHistory(container: HTMLElement) {
  const details = container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('VersionHistory', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('fetches only once opened', async () => {
    mockVersions([makeVersion()])
    const { container } = render(<VersionHistory resourceId="r1" />)
    expect(mockClientFetch).not.toHaveBeenCalled()

    openHistory(container)
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/versions')
    expect(await screen.findByText('v1')).toBeInTheDocument()

    // Re-toggling does not refetch — the list is already on screen.
    fireEvent(container.querySelector('details')!, new Event('toggle'))
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
  })

  it('renders download links, marks the live version, and shows tombstones without one', async () => {
    mockVersions([
      makeVersion({ version: 3, isLive: true }),
      makeVersion({ version: 2 }),
      makeVersion({
        version: 1,
        state: 'purged',
        size: null,
        hash: null,
        purgedAt: '2026-08-02T00:00:00.000Z',
      }),
    ])
    const { container } = render(<VersionHistory resourceId="r1" />)
    openHistory(container)

    expect(await screen.findByText('v3')).toBeInTheDocument()
    expect(screen.getByText('Current version')).toBeInTheDocument()
    expect(screen.getByText('Deleted')).toBeInTheDocument()

    // The two alive versions download; the tombstone has nothing to serve.
    const links = screen.getAllByRole('link', { name: 'Download' })
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/api/v1/resources/r1/versions/3/download',
      '/api/v1/resources/r1/versions/2/download',
    ])
  })

  it('keeps the tail behind "show all"', async () => {
    mockVersions(Array.from({ length: 12 }, (_, i) => makeVersion({ version: 12 - i })))
    const { container } = render(<VersionHistory resourceId="r1" />)
    openHistory(container)

    expect(await screen.findByText('v12')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.queryByText('v2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show all versions (12)' }))
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('says so when there is no history', async () => {
    mockVersions([])
    const { container } = render(<VersionHistory resourceId="r1" />)
    openHistory(container)

    expect(await screen.findByText('No version history')).toBeInTheDocument()
  })

  it('recovers from a failed load via retry', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network'))
    const { container } = render(<VersionHistory resourceId="r1" />)
    openHistory(container)

    expect(await screen.findByText('Failed to load version history')).toBeInTheDocument()

    mockVersions([makeVersion()])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('v1')).toBeInTheDocument()
  })
})
