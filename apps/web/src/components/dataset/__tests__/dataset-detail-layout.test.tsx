import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { serverFetch, getCurrentUser } from '@/lib/server-api'
import { DatasetDetailLayout, type Package } from '../dataset-detail-layout'

vi.mock('@/lib/server-api', () => ({
  serverFetch: vi.fn(),
  getCurrentUser: vi.fn(),
}))

// An async server component of its own, which the client renderer cannot render
vi.mock('../dataset-metadata', () => ({
  DatasetMetadata: () => null,
}))

vi.mock('@/components/resource/resource-explorer', () => ({
  ResourceExplorer: (props: {
    sectionTitle: string
    canManage: boolean
    notPublic: boolean
    initialResourceId?: string
  }) => (
    <div
      data-testid="resource-explorer"
      data-can-manage={String(props.canManage)}
      data-not-public={String(props.notPublic)}
      data-initial={props.initialResourceId ?? ''}
    >
      {props.sectionTitle}
    </div>
  ),
}))

type User = Awaited<ReturnType<typeof getCurrentUser>>

const basePkg: Package = {
  id: 'pkg-1',
  name: 'population-data',
  title: 'Population Data',
  private: false,
  state: 'active',
  ownerOrg: 'org-1',
  created: '2025-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  resources: [{ id: 'r1', name: 'population.csv', format: 'CSV' } as Package['resources'][number]],
  tags: [],
  groups: [],
  organization: null,
}

function memberOf(...ids: string[]) {
  return { ok: true, json: async () => ({ items: ids.map((id) => ({ id })) }) } as Response
}

async function renderLayout(pkg: Partial<Package> = {}, initialResourceId?: string) {
  render(await DatasetDetailLayout({ pkg: { ...basePkg, ...pkg }, initialResourceId }))
}

const explorer = () => screen.getByTestId('resource-explorer')

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(null)
  vi.mocked(serverFetch).mockReset().mockResolvedValue(memberOf())
})

describe('DatasetDetailLayout', () => {
  it('heads the page with the title, and the name beneath it', async () => {
    await renderLayout()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Population Data')
    expect(screen.getByText('population-data')).toBeInTheDocument()
  })

  it('heads the page with the name where there is no title', async () => {
    await renderLayout({ title: null })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('population-data')
    expect(screen.getAllByText('population-data')).toHaveLength(2)
  })

  it('links the organization, groups and tags, and names the license', async () => {
    await renderLayout({
      organization: { id: 'org-1', name: 'tokyo', title: 'Tokyo' },
      groups: [{ id: 'g1', name: 'stats', title: null }],
      tags: [{ id: 't1', name: 'census' }],
      licenseId: 'GJSTU-2.0',
    })
    expect(screen.getByRole('link', { name: 'Tokyo' })).toHaveAttribute(
      'href',
      '/organization/tokyo'
    )
    expect(screen.getByRole('link', { name: 'stats' })).toHaveAttribute('href', '/group/stats')
    expect(screen.getByRole('link', { name: 'census' })).toHaveAttribute('href', '/tag/census')
    expect(
      screen.getByText('Government of Japan Standard Terms of Use (Version 2.0)')
    ).toBeInTheDocument()
  })

  it('renders the description, and says so where there are no resources', async () => {
    await renderLayout({ notes: 'About **people**', resources: [] })
    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByText('No resources')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-explorer')).not.toBeInTheDocument()
  })

  it('lists the resources with their count, opening the one asked for', async () => {
    await renderLayout({}, 'r1')
    expect(explorer()).toHaveTextContent('Resources (1)')
    expect(explorer()).toHaveAttribute('data-initial', 'r1')
    expect(explorer()).toHaveAttribute('data-not-public', 'false')
  })

  it.each([
    ['private', { private: true }],
    ['a draft', { state: 'draft' as const }],
  ])('marks the resources not public for %s dataset', async (_label, pkg) => {
    await renderLayout(pkg)
    expect(explorer()).toHaveAttribute('data-not-public', 'true')
  })

  describe('who may manage', () => {
    it('lets a sysadmin manage, a member of no organization', async () => {
      vi.mocked(getCurrentUser).mockResolvedValue({ sysadmin: true } as User)
      await renderLayout()
      expect(explorer()).toHaveAttribute('data-can-manage', 'true')
    })

    it('lets a member of the owning organization manage', async () => {
      vi.mocked(getCurrentUser).mockResolvedValue({ sysadmin: false } as User)
      vi.mocked(serverFetch).mockResolvedValue(memberOf('org-2', 'org-1'))
      await renderLayout()
      expect(serverFetch).toHaveBeenCalledWith('/api/v1/users/me/organizations')
      expect(explorer()).toHaveAttribute('data-can-manage', 'true')
    })

    it.each([
      ['a signed-out visitor', null, async () => memberOf('org-1')],
      ['a member of another organization', { sysadmin: false }, async () => memberOf('org-2')],
      [
        'a user whose organizations failed to load',
        { sysadmin: false },
        async (): Promise<Response> => {
          throw new Error('down')
        },
      ],
      [
        'a user whose organizations answered an error',
        { sysadmin: false },
        async () => ({ ok: false }) as Response,
      ],
    ])('does not let %s manage', async (_label, user, orgs) => {
      vi.mocked(getCurrentUser).mockResolvedValue(user as User)
      vi.mocked(serverFetch).mockImplementation(orgs)
      await renderLayout()
      expect(explorer()).toHaveAttribute('data-can-manage', 'false')
    })

    it('does not let a user manage a dataset with no owning organization', async () => {
      vi.mocked(getCurrentUser).mockResolvedValue({ sysadmin: false } as User)
      vi.mocked(serverFetch).mockResolvedValue(memberOf('org-1'))
      await renderLayout({ ownerOrg: null })
      expect(explorer()).toHaveAttribute('data-can-manage', 'false')
    })
  })
})
