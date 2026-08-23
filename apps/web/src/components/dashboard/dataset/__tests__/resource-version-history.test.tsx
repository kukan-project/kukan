import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { ResourceVersionHistory } from '../resource-version-history'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

/** A sysadmin throughout: the purge control is offered to no one else. */
vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({ id: 'u1', name: 'u', email: 'u@example.com', sysadmin: true }),
}))

const mockClientFetch = vi.mocked(clientFetch)

function versionsResponse(versions: unknown[]) {
  return { ok: true, json: async () => ({ versions }) } as Response
}

function version(
  n: number,
  overrides: {
    hash?: string
    state?: string
    isLive?: boolean
    purgeFallsBackTo?: number | null
    origin?: string
    restoredFrom?: number | null
    keyColumns?: string[] | null
  } = {}
) {
  return {
    version: n,
    origin: 'upload',
    restoredFrom: null,
    state: 'active',
    isLive: false,
    purgeFallsBackTo: null,
    size: 10,
    hash: `sha256:v${n}`,
    noTableReason: null,
    keyColumns: null,
    created: '2026-08-08T00:00:00.000Z',
    purgedAt: null,
    ...overrides,
  }
}

describe('ResourceVersionHistory', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should reload when the owner bumps reloadKey', async () => {
    mockClientFetch
      .mockResolvedValueOnce(versionsResponse([version(1)]))
      .mockResolvedValueOnce(versionsResponse([version(2), version(1)]))
    const { rerender } = render(<ResourceVersionHistory resourceId="r1" reloadKey={1} />)

    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument())

    // The replacement's run finished — the owner refetched, so the open panel
    // must show the version it produced without being remounted
    rerender(<ResourceVersionHistory resourceId="r1" reloadKey={2} />)
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())
  })

  it('says what each version was read under', async () => {
    // Recorded per version because the resource's own setting answers a
    // different question: it is what the *next* version will be read under
    // (spec §6.4). A keyless version says nothing rather than "none".
    mockClientFetch.mockResolvedValue(
      versionsResponse([version(2, { keyColumns: ['order', 'line'] }), version(1)])
    )
    render(<ResourceVersionHistory resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: 'Primary key' })).toBeInTheDocument()
    )
    expect(screen.getByText('order → line (composite)')).toBeInTheDocument()
    // A keyless version says so rather than leaving the column blank, and a
    // single-column key is named as one — the two are not the same thing to
    // the check that has to answer for them.
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('keeps a long key name from widening the table it is listed in', async () => {
    // A column name is a CSV header — arbitrary text, and where the delimiter
    // was not found, one column named after the whole line. Rendered as
    // it comes it widens this table, then the editor row it sits in, then the
    // page, and the horizontal scrollbar belongs to the screen.
    const wide = 'x'.repeat(4000)
    mockClientFetch.mockResolvedValue(versionsResponse([version(1, { keyColumns: [wide] })]))
    render(<ResourceVersionHistory resourceId="r1" />)

    const shown = await screen.findByTitle(`${wide} (single)`)
    expect(shown).toHaveClass('truncate')
    expect(shown.className).toMatch(/max-w-/)
  })

  it('names a single-column key as one', async () => {
    // Single and composite are not the same thing to the check that answers for
    // them: one is read off counts the version already froze, the other has to
    // be read out of the content.
    mockClientFetch.mockResolvedValue(versionsResponse([version(1, { keyColumns: ['order'] })]))
    render(<ResourceVersionHistory resourceId="r1" />)

    await waitFor(() => expect(screen.getByText('order (single)')).toBeInTheDocument())
  })

  it('says which version a reverted one re-published', async () => {
    // The history is the only place that answers it: content and its reading
    // repeat by design (ADR-046 §3), so nothing here could work the number out
    // by comparing hashes — it comes off the row (ADR-044 §4).
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([version(3, { origin: 'revert', restoredFrom: 1 }), version(2), version(1)])
    )
    render(<ResourceVersionHistory resourceId="r1" />)

    expect(await screen.findByText(/Re-published v1/)).toBeInTheDocument()
  })

  it('names a revert with no number rather than rendering the message key', async () => {
    // The server withholds the number when either end is a tombstone (ADR-044
    // §4), so `origin: 'revert'` with no `restoredFrom` is reachable on current
    // data — and the parameterized message would render its own key there.
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([version(3, { origin: 'revert', restoredFrom: null, state: 'purged' })])
    )
    render(<ResourceVersionHistory resourceId="r1" />)

    const badge = await screen.findByText('Re-published')
    expect(badge).toBeInTheDocument()
    expect(screen.queryByText(/originRevert/)).not.toBeInTheDocument()
  })

  it('names the versions a purge will leave holding the same content', async () => {
    // Shared bytes: purging v3 leaves v1 serving them.
    const shared = 'sha256:same'
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([version(3, { hash: shared }), version(2), version(1, { hash: shared })])
    )
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('v1')
    expect(warning).not.toHaveTextContent('v2')
  })

  it("says nothing when the content is this version's alone", async () => {
    mockClientFetch.mockResolvedValueOnce(versionsResponse([version(2), version(1)]))
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])

    await screen.findByRole('dialog')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  /**
   * Which of §9.6's three cases the confirmation names, from the two facts the
   * server sends (`isLive`, `purgeFallsBackTo`).
   *
   * These exist because nothing checked the wording: the choice was made wrongly
   * three times over four rounds of review and no test noticed. Each case asserts
   * the other branches' sentences are absent, since picking the wrong one still
   * produces a dialog full of plausible prose.
   */
  describe('the purge confirmation names what will happen (spec §9.6)', () => {
    async function openPurge(versions: unknown[]) {
      mockClientFetch.mockResolvedValueOnce(versionsResponse(versions))
      render(<ResourceVersionHistory resourceId="r1" />)
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /delete/i })).not.toHaveLength(0)
      )
      fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
      return screen.findByRole('dialog')
    }

    it('names where serving falls back to, purging the version being served', async () => {
      const dialog = await openPurge([
        version(2, { isLive: true, purgeFallsBackTo: 1 }),
        version(1),
      ])

      expect(dialog).toHaveTextContent('serving falls back to v1')
      expect(dialog).not.toHaveTextContent('not what the resource is serving')
      expect(dialog).not.toHaveTextContent('no version left to fall back to')
    })

    it('says the resource is left with no file when nothing survives it', async () => {
      const dialog = await openPurge([version(1, { isLive: true })])

      expect(dialog).toHaveTextContent('no version left to fall back to')
      expect(dialog).not.toHaveTextContent('serving falls back to')
    })

    it('says nothing derived changes when the version is not the one being served', async () => {
      const dialog = await openPurge([version(2), version(1, { isLive: true })])

      expect(dialog).toHaveTextContent('What is being served, its preview and its search index')
      expect(dialog).not.toHaveTextContent('serving falls back to')
      expect(dialog).not.toHaveTextContent('no version left to fall back to')
    })

    it('says the caveat, the download advice and the storage note whatever the case', async () => {
      // Rendered unconditionally, so one case is enough to hold them — but §9.6
      // asks for them in every branch, and dropping them is invisible otherwise.
      const dialog = await openPurge([version(1, { isLive: true })])

      expect(dialog).toHaveTextContent('Serving can move before you confirm')
      expect(dialog).toHaveTextContent('download it first')
      expect(dialog).toHaveTextContent('rows may remain')
    })
  })

  it('does not offer a version already being purged as a survivor', async () => {
    // It is being destroyed too, and a second purge is refused while the first
    // is in flight — so naming it would promise a survivor and send the
    // operator after an operation the resource will not accept.
    const shared = 'sha256:same'
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([
        version(2, { hash: shared }),
        version(1, { hash: shared, state: 'purging' }),
      ])
    )
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])

    await screen.findByRole('dialog')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
