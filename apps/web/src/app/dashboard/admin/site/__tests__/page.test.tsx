import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  // The real one throws to unwind the render; this stands in for that
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
}))

vi.mock('@/lib/server-api', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/components/dashboard/ai/ai-suggest-card', () => ({
  AiSuggestCard: () => <section>suggestions</section>,
}))

// Carries a card title like the real one, so the order assertion below can see
// it move
vi.mock('@/components/dashboard/site/data-reset-card', () => ({
  DataResetCard: () => (
    <section>
      <div data-slot="card-title">Data Reset</div>
    </section>
  ),
}))

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/server-api'
import { version } from '../../../../../../../../package.json'
import AdminSitePage from '../page'

const sysadmin = {
  id: 'u1',
  name: 'admin',
  email: 'admin@example.com',
  displayName: null,
  sysadmin: true,
}

describe('AdminSitePage', () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue(sysadmin)
    vi.mocked(redirect).mockClear()
  })

  it('renders the page title', async () => {
    render(await AdminSitePage())
    expect(screen.getByText('Site Management')).toBeInTheDocument()
  })

  it('leaves everything about AI to the AI page', async () => {
    render(await AdminSitePage())
    expect(screen.queryByText('Generate AI descriptions in bulk')).not.toBeInTheDocument()
    expect(screen.queryByText('Regenerate embeddings')).not.toBeInTheDocument()
    expect(screen.queryByText('suggestions')).not.toBeInTheDocument()
    expect(screen.queryByText('Semantic search')).not.toBeInTheDocument()
  })

  it('puts the running version above the cards that change something', async () => {
    const { container } = render(await AdminSitePage())

    const titles = [...container.querySelectorAll('[data-slot="card-title"]')].map(
      (el) => el.textContent
    )

    expect(titles[0]).toBe('Running version')
    // And the one that deletes everything is somewhere below it
    expect(titles.indexOf('Data Reset')).toBeGreaterThan(0)
  })

  it('has the release and the Node version in the first render', async () => {
    render(await AdminSitePage())

    // The release comes from the repository's package.json, which `next build`
    // embeds (ADR-035), and Node's from the process
    expect(screen.getByText(version)).toBeInTheDocument()
    expect(screen.getByText(process.version.replace(/^v/, ''))).toBeInTheDocument()
  })

  // The page is rendered on the server and the version is in its payload, so
  // it carries its own check rather than relying on the layout above it: a
  // layout is not re-rendered on every navigation, and the client states which
  // layouts it already holds.
  it.each([
    ['a user who is not sysadmin', { ...sysadmin, sysadmin: false }],
    ['nobody signed in', null],
  ])('sends %s to the dashboard instead of rendering', async (_label, user) => {
    vi.mocked(getCurrentUser).mockResolvedValue(user)

    await expect(AdminSitePage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/dashboard')
  })

  it('renders the data reset card', async () => {
    render(await AdminSitePage())
    expect(screen.getByText('Data Reset')).toBeInTheDocument()
  })
})
