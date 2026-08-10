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

function version(n: number, hash = `sha256:v${n}`, state = 'active') {
  return {
    version: n,
    origin: 'upload',
    state,
    size: 10,
    hash,
    noTableReason: null,
    created: '2026-08-08T00:00:00.000Z',
    purgedAt: null,
    purgeReason: null,
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

  it('names the versions a purge will leave holding the same content', async () => {
    // Shared bytes: purging v3 leaves v1 serving them.
    const shared = 'sha256:same'
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([version(3, shared), version(2), version(1, shared)])
    )
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /purge/i })[0])

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('v1')
    expect(warning).not.toHaveTextContent('v2')
  })

  it("says nothing when the content is this version's alone", async () => {
    mockClientFetch.mockResolvedValueOnce(versionsResponse([version(2), version(1)]))
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /purge/i })[0])

    await screen.findByRole('dialog')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not offer a version already being purged as a survivor', async () => {
    // It is being destroyed too, and a second purge is refused while the first
    // is in flight — so naming it would promise a survivor and send the
    // operator after an operation the resource will not accept.
    const shared = 'sha256:same'
    mockClientFetch.mockResolvedValueOnce(
      versionsResponse([version(2, shared), version(1, shared, 'purging')])
    )
    render(<ResourceVersionHistory resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /purge/i })[0])

    await screen.findByRole('dialog')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
