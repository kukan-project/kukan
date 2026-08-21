import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { VersionDiffPanel } from '../version-diff-panel'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

function mockDiff(data: unknown) {
  vi.mocked(clientFetch).mockResolvedValue({ ok: true, json: async () => data } as Response)
}

describe('VersionDiffPanel', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
  })

  it('requests the diff for the given version on mount', async () => {
    mockDiff({ available: false, reason: 'no-previous-version', from: null, to: 1 })

    render(<VersionDiffPanel resourceId="r1" version={1} />)

    await waitFor(() =>
      expect(vi.mocked(clientFetch)).toHaveBeenCalledWith(
        '/api/v1/resources/r1/versions/1/diff',
        expect.anything()
      )
    )
  })

  it('shows the changed count and sample when the rows were matched by a key', async () => {
    mockDiff({
      available: true,
      from: 1,
      to: 2,
      keyed: true,
      addedRows: 1,
      removedRows: 0,
      changedRows: 2,
      schemaChanged: false,
      schemaDiff: { added: [], removed: [], retyped: [] },
      sampleAdded: [],
      sampleRemoved: [],
      sampleChangedAfter: [{ id: 1, name: 'A' }],
    })

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() => expect(screen.getByText('2 rows changed')).toBeInTheDocument())
    expect(screen.getByText('Changed rows (sample, as they now are)')).toBeInTheDocument()
  })

  it('shows no changed count where the rows were compared whole', async () => {
    // "0 changed" would read as "nothing was edited" where the truth is that an
    // edit cannot be told from an addition and a removal (spec §7.1).
    mockDiff({
      available: true,
      from: 1,
      to: 2,
      keyed: false,
      addedRows: 1,
      removedRows: 1,
      schemaChanged: false,
      schemaDiff: { added: [], removed: [], retyped: [] },
      sampleAdded: [],
      sampleRemoved: [],
    })

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() => expect(screen.getByText('1 rows added')).toBeInTheDocument())
    expect(screen.queryByText(/changed/)).not.toBeInTheDocument()
  })

  it('shows added and removed row counts', async () => {
    mockDiff({
      available: true,
      from: 1,
      to: 2,
      addedRows: 3,
      removedRows: 1,
      schemaChanged: false,
      // Stated, not left out: the panel's rule is about this field, and an
      // absent one would pass by being falsy rather than by being false.
      keyed: false,
      schemaDiff: { added: [], removed: [], retyped: [] },
      sampleAdded: [{ id: 4, name: 'd' }],
      sampleRemoved: [],
    })

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() => expect(screen.getByText('3 rows added')).toBeInTheDocument())
    expect(screen.getByText('1 rows removed')).toBeInTheDocument()
  })

  it('explains a schema change instead of showing row counts', async () => {
    mockDiff({
      available: true,
      from: 1,
      to: 2,
      addedRows: null,
      removedRows: null,
      schemaChanged: true,
      schemaDiff: {
        added: [{ name: 'extra', type: 'VARCHAR' }],
        removed: [],
        retyped: [],
      },
      sampleAdded: [],
      sampleRemoved: [],
    })

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() =>
      expect(
        screen.getByText('The columns changed, so a row-level diff is not available.')
      ).toBeInTheDocument()
    )
    expect(screen.getByText('+ extra (VARCHAR)')).toBeInTheDocument()
    expect(screen.queryByText(/rows added/)).not.toBeInTheDocument()
  })

  it.each([
    ['purged', 'One of the versions has been purged, so a diff is not available.'],
    [
      'not-ingested',
      'This version is not covered by diffs (not tabular, or captured before the feature was introduced).',
    ],
    ['no-previous-version', 'This is the first version, so there is nothing to compare against.'],
  ])('explains why a diff is unavailable (%s)', async (reason, message) => {
    mockDiff({ available: false, reason, from: 1, to: 2 })

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
  })

  it('shows an error when the request fails', async () => {
    vi.mocked(clientFetch).mockResolvedValue({ ok: false, status: 500 } as Response)

    render(<VersionDiffPanel resourceId="r1" version={2} />)

    await waitFor(() => expect(screen.getByText('Failed to load the diff')).toBeInTheDocument())
  })
})
