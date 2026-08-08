import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { ResourceVersionHistory } from '../resource-version-history'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({ id: 'u1', name: 'u', email: 'u@example.com', sysadmin: false }),
}))

const mockClientFetch = vi.mocked(clientFetch)

function versionsResponse(versions: unknown[]) {
  return { ok: true, json: async () => ({ versions }) } as Response
}

function version(n: number) {
  return {
    version: n,
    origin: 'upload',
    state: 'active',
    size: 10,
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
})
