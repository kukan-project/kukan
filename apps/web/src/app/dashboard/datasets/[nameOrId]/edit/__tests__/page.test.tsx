import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  })
)
vi.mock('next/navigation', () => ({ redirect }))
const serverFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/server-api', () => ({ serverFetch }))

import LegacyEditRedirect from '../page'

async function landing(nameOrId: string, query: Record<string, string>) {
  await expect(
    LegacyEditRedirect({
      params: Promise.resolve({ nameOrId }),
      searchParams: Promise.resolve(query),
    })
  ).rejects.toThrow('NEXT_REDIRECT')
  return redirect.mock.calls.at(-1)?.[0]
}

const ID = '0b8f4e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'

/** Answers the package read: found under `found`, or not at all */
function packages(found: Record<string, string>) {
  serverFetch.mockImplementation(async (path: string) => {
    const hit = Object.entries(found).find(([prefix]) => path.startsWith(prefix))
    return hit
      ? ({ ok: true, json: async () => ({ id: hit[1] }) } as Response)
      : ({ ok: false, json: async () => ({}) } as Response)
  })
}

beforeEach(() => {
  serverFetch.mockReset()
  packages({ '/api/v1/packages/pkg-1': ID })
})

describe('the editor’s previous address', () => {
  it('goes on by id, so a dataset named like a page of its own still reaches its editor', async () => {
    // `/dashboard/datasets/new` is the creation page
    packages({ '/api/v1/packages/new': ID })
    expect(await landing('new', {})).toBe(`/dashboard/datasets/${ID}`)
  })

  it('looks for a draft too, when the address does not say it is one', async () => {
    packages({ '/api/v1/packages/pkg-1?state=draft': ID })
    expect(await landing('pkg-1', {})).toBe(`/dashboard/datasets/${ID}`)
  })

  it('reads nothing for an address that already holds an id', async () => {
    expect(await landing(ID, {})).toBe(`/dashboard/datasets/${ID}`)
    expect(serverFetch).not.toHaveBeenCalled()
  })

  it('passes on a name that cannot be read, for the editor to say it is not there', async () => {
    packages({})
    expect(await landing('gone', {})).toBe('/dashboard/datasets/gone')
  })

  it('goes on to the dataset page', async () => {
    expect(await landing('pkg-1', {})).toBe(`/dashboard/datasets/${ID}`)
  })

  it('opens the resource it named on a page of its own', async () => {
    expect(await landing('pkg-1', { resource: 'r1' })).toBe(
      `/dashboard/datasets/${ID}/resources/r1`
    )
  })

  it('keeps the state, which the package API needs to find a draft or a deleted dataset', async () => {
    expect(await landing('pkg-1', { state: 'deleted' })).toBe(
      `/dashboard/datasets/${ID}?state=deleted`
    )
    expect(await landing('pkg-1', { state: 'draft', resource: 'r1' })).toBe(
      `/dashboard/datasets/${ID}/resources/r1?state=draft`
    )
  })

  it('drops a state the API would not take', async () => {
    expect(await landing('pkg-1', { state: 'whatever' })).toBe(`/dashboard/datasets/${ID}`)
  })
})
