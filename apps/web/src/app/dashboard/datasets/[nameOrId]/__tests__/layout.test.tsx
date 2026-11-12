import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))

const nav = vi.hoisted(() => ({
  nameOrId: 'population',
  pathname: '/dashboard/datasets/population/resources/r1',
  search: 'state=draft',
  replace: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useParams: () => ({ nameOrId: nav.nameOrId }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
}))
vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => ({ id: 'user-1', sysadmin: false }),
}))
// The list is tested on its own; here it only has to say whether it may write
vi.mock('@/components/dashboard/dataset/dataset-editor-nav', () => ({
  DatasetEditorNav: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="nav">{readOnly ? 'read-only' : 'writable'}</div>
  ),
}))

import DatasetEditorLayout from '../layout'
import {
  useDatasetEditor,
  type EditorPackage,
} from '@/components/dashboard/dataset/dataset-editor-context'

/** What a page under the layout reads of the context, and a way to hand it a copy */
function Page() {
  const editor = useDatasetEditor()
  return (
    <>
      <span>{editor?.missing ? 'missing' : 'present'}</span>
      <button
        type="button"
        onClick={() => editor?.publish(pkg as unknown as EditorPackage, editor.mark())}
      >
        hand over
      </button>
    </>
  )
}

const pkg = { id: 'pkg-1', name: 'population', state: 'draft', ownerOrg: 'org-1', resources: [] }

function serve(role: string) {
  vi.mocked(clientFetch).mockImplementation(
    async (path: string) =>
      ({
        ok: true,
        json: async () =>
          path.includes('/users/me/organizations')
            ? { items: [{ id: 'org-1', name: 'o', role }] }
            : pkg,
      }) as Response
  )
}

describe('DatasetEditorLayout', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    nav.replace.mockReset()
  })

  it('moves an address that names the dataset to its id, keeping the rest', async () => {
    // The list links by id; left on the name, its first link would remount the
    // editor and drop what it holds
    serve('editor')
    render(<DatasetEditorLayout>page</DatasetEditorLayout>)
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/dashboard/datasets/pkg-1/resources/r1?state=draft')
    )
  })

  it('lets an editor of the organization write, and a reader only look', async () => {
    serve('editor')
    const { unmount } = render(<DatasetEditorLayout>page</DatasetEditorLayout>)
    expect(await screen.findByText('writable')).toBeInTheDocument()
    unmount()

    serve('member')
    render(<DatasetEditorLayout>page</DatasetEditorLayout>)
    await waitFor(() => expect(vi.mocked(clientFetch)).toHaveBeenCalled())
    expect(await screen.findByText('read-only')).toBeInTheDocument()
  })

  it('stops calling the dataset missing once a copy of it arrives', async () => {
    // Its first read failed, and the dataset page read it on its own
    vi.mocked(clientFetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response)
    render(
      <DatasetEditorLayout>
        <Page />
      </DatasetEditorLayout>
    )
    expect(await screen.findByText('missing')).toBeInTheDocument()

    fireEvent.click(screen.getByText('hand over'))
    expect(await screen.findByText('present')).toBeInTheDocument()
  })
})
