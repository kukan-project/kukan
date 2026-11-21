import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import {
  DatasetEditorProvider,
  type EditorPackage,
} from '@/components/dashboard/dataset/dataset-editor-context'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))

const nav = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/datasets/pkg-1/resources/r1',
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => ({ nameOrId: 'pkg-1', resourceId: 'r1' }),
}))

// The panels are tested on their own; here they only have to be where the tabs put them
vi.mock('@/components/dashboard/dataset/table-settings', () => ({
  // Draws the preview it is handed, with a key being picked, as the real one does
  TableSettings: ({ preview }: { preview?: (key: string[] | null) => React.ReactNode }) => (
    <div data-testid="table-settings">{preview?.(['id'])}</div>
  ),
}))
vi.mock('@/components/dashboard/dataset/resource-version-history', () => ({
  ResourceVersionHistory: () => <div data-testid="version-history" />,
}))
vi.mock('@/components/dashboard/dataset/resource-edit-form', () => ({
  ResourceEditForm: ({
    resource,
    onSaved,
  }: {
    resource: { name?: string }
    onSaved: () => void
  }) => (
    <div data-testid="resource-edit-form">
      {resource.name}
      <button type="button" data-testid="resource-edit-form-save" onClick={onSaved} />
    </div>
  ),
}))
const preview = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('@/components/resource/resource-pipeline-preview', () => ({
  ResourcePipelinePreview: (props: Record<string, unknown>) => {
    preview.props = props
    return <div data-testid="resource-preview" />
  },
}))
const detail = vi.hoisted(() => ({ onStarted: undefined as (() => void) | undefined }))
vi.mock('@/components/resource/pipeline-status-detail', () => ({
  PipelineStatusDetail: ({ onStarted }: { onStarted?: () => void }) => {
    detail.onStarted = onStarted
    return <div data-testid="pipeline-status" />
  },
}))
vi.mock('@/components/dashboard/dataset/pipeline-status-badge', () => ({
  PipelineStatusBadge: () => null,
  STATUS_KEYS: {},
}))

import ResourceEditorPage from '../page'

const pkg: EditorPackage = {
  id: 'pkg-1',
  name: 'population',
  state: 'active',
  resources: [{ id: 'r1', name: 'data.csv', format: 'CSV', pipelineStatus: 'complete' }],
}

const reload = vi.fn()

function renderPage(
  resource: Record<string, unknown>,
  editorPkg: EditorPackage = pkg,
  canEdit = true,
  tab?: { resourceTab: string; setResourceTab: (tab: string) => void }
) {
  vi.mocked(clientFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'r1', name: 'data.csv', ...resource }),
  } as Response)
  render(
    <DatasetEditorProvider
      value={{
        pkg: editorPkg,
        mark: () => 0,
        publish: vi.fn(),
        reload,
        canEdit,
        readOnly: !canEdit || editorPkg.state === 'deleted',
        organizations: [],
        setPageReloader: () => {},
        uploading: false,
        setPageUnsaved: () => {},
        ...tab,
      }}
    >
      <ResourceEditorPage />
    </DatasetEditorProvider>
  )
}

describe('ResourceEditorPage', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    nav.search = ''
  })

  it('opens on the tab the last resource was left on, and tells the editor of a move', async () => {
    // Moving between a dataset's resources keeps the tab
    const setResourceTab = vi.fn()
    renderPage({ format: 'CSV' }, pkg, true, { resourceTab: 'versions', setResourceTab })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Version history' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Table settings' }))
    expect(setResourceTab).toHaveBeenCalledWith('columns')
  })

  it('opens on the preview where Table settings is remembered and the resource is no table', async () => {
    // A table's preview is on its Table settings tab, so each stands for the other
    renderPage({ format: 'PDF' }, pkg, true, { resourceTab: 'columns', setResourceTab: vi.fn() })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
    )
  })

  it('opens on Basic where the remembered tab is not offered, and stays there once it is', async () => {
    // Processing is only for a writer's resource... and a format that becomes
    // a table on save must not move the page off the form being used.
    const setResourceTab = vi.fn()
    let format = 'PDF'
    vi.mocked(clientFetch).mockImplementation(
      async () =>
        ({ ok: true, json: async () => ({ id: 'r1', name: 'data.csv', format }) }) as Response
    )
    render(
      <DatasetEditorProvider
        value={{
          pkg,
          mark: () => 0,
          publish: vi.fn(),
          reload,
          canEdit: true,
          readOnly: false,
          organizations: [],
          setPageReloader: () => {},
          uploading: false,
          setPageUnsaved: () => {},
          resourceTab: 'basic',
          setResourceTab,
        }}
      >
        <ResourceEditorPage />
      </DatasetEditorProvider>
    )
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Basic' })).toHaveAttribute('aria-selected', 'true')
    )
    expect(setResourceTab).not.toHaveBeenCalled()

    // The form saves the format; the page reads the resource again
    format = 'CSV'
    fireEvent.click(screen.getByTestId('resource-edit-form-save'))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Table settings' })).toBeInTheDocument()
    )
    expect(screen.getByRole('tab', { name: 'Basic' })).toHaveAttribute('aria-selected', 'true')
  })

  it('splits the resource into tabs, with the columns for a table', async () => {
    renderPage({ format: 'CSV', url: 'https://example.com/a.csv' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Basic' })).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Table settings' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Version history' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Processing' })).toBeInTheDocument()

    // Radix tabs select on mousedown
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Table settings' }))
    expect(screen.getByTestId('table-settings')).toBeInTheDocument()
  })

  it('previews a table on its Table settings tab, with the key being picked and no field list', async () => {
    renderPage({ format: 'CSV' })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Table settings' })).toBeInTheDocument()
    )
    expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Table settings' }))
    expect(
      within(screen.getByTestId('table-settings')).getByTestId('resource-preview')
    ).toBeInTheDocument()
    expect(preview.props).toMatchObject({ primaryKey: ['id'], withFields: false })
  })

  it('offers no columns for what is not read as a table', async () => {
    renderPage({ format: 'PDF' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Basic' })).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: 'Table settings' })).not.toBeInTheDocument()
  })

  it('edits the resource on its Basic tab', async () => {
    renderPage({ format: 'CSV' })
    expect(await screen.findByTestId('resource-edit-form')).toHaveTextContent('data.csv')
    expect(screen.getByRole('button', { name: 'Delete This Resource' })).toBeInTheDocument()
  })

  it('only shows a deleted dataset’s resource, which cannot be written', async () => {
    renderPage({ format: 'CSV', description: 'counts' }, { ...pkg, state: 'deleted' })
    expect(await screen.findByText('counts')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-edit-form')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete This Resource' })).not.toBeInTheDocument()
  })

  it('reads the resource again when a version arrives that no run was seen making', async () => {
    // A run that finished between two reads of the list is never seen under
    // way; the version it stored still carries a new hash, size and abstract
    const value = (latestVersion: number) => ({
      pkg: { ...pkg, resources: [{ ...pkg.resources[0], latestVersion }] },
      mark: () => 0,
      publish: vi.fn(),
      reload,
      canEdit: true,
      readOnly: false,
      organizations: [],
      setPageReloader: () => {},
      uploading: false,
      setPageUnsaved: () => {},
    })
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'r1', name: 'data.csv', format: 'PDF' }),
    } as Response)
    const reads = () =>
      vi.mocked(clientFetch).mock.calls.filter(([url]) => url === '/api/v1/resources/r1').length
    const { rerender } = render(
      <DatasetEditorProvider value={value(1)}>
        <ResourceEditorPage />
      </DatasetEditorProvider>
    )
    await screen.findByTestId('resource-edit-form')
    const before = reads()

    rerender(
      <DatasetEditorProvider value={value(2)}>
        <ResourceEditorPage />
      </DatasetEditorProvider>
    )
    await waitFor(() => expect(reads()).toBe(before + 1))
  })

  it('shows no resource under a dataset that could not be read', async () => {
    // The resource on its own can still be read; whether it is this dataset's,
    // and who may write it, cannot
    vi.mocked(clientFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'r1', name: 'data.csv', format: 'CSV' }),
    } as Response)
    render(
      <DatasetEditorProvider
        value={{
          pkg: null,
          mark: () => 0,
          publish: vi.fn(),
          reload,
          canEdit: false,
          readOnly: true,
          organizations: [],
          setPageReloader: () => {},
          uploading: false,
          setPageUnsaved: () => {},
          missing: true,
        }}
      >
        <ResourceEditorPage />
      </DatasetEditorProvider>
    )
    expect(await screen.findByText('Resource not found')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Basic' })).not.toBeInTheDocument()
  })

  it('says so when the resource is not there', async () => {
    vi.mocked(clientFetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response)
    render(<ResourceEditorPage />)
    expect(await screen.findByText('Resource not found')).toBeInTheDocument()
  })

  it('turns away who may not write the dataset, as the dataset page does', async () => {
    // The editor is for writers; a reader reads the public page
    renderPage({ format: 'CSV', description: 'counts' }, pkg, false)
    expect(
      await screen.findByText(/You do not have permission to edit this dataset/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Basic' })).not.toBeInTheDocument()
  })

  it('previews the resource as the public page does, also for a draft', async () => {
    renderPage(
      { format: 'PDF', url: 'https://example.com/a.csv', urlType: null, size: 10 },
      { ...pkg, state: 'draft' }
    )
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument())
    expect(screen.queryByTestId('resource-preview')).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByTestId('resource-preview')).toBeInTheDocument()
    expect(preview.props).toMatchObject({
      url: 'https://example.com/a.csv',
      // A draft has no public page; its files stay away from third-party viewers
      notPublic: true,
    })
  })

  it('gives an uploaded file no outside link to preview from', async () => {
    renderPage({ format: 'PDF', url: 'data.csv', urlType: 'upload' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Preview' }))
    expect(preview.props).toMatchObject({ url: null, notPublic: false })
  })

  it('says the preview is waiting for a run rather than leave "no preview" to read as final', async () => {
    renderPage(
      { format: 'PDF' },
      { ...pkg, resources: [{ ...pkg.resources[0], pipelineStatus: 'processing' }] }
    )
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByText(/Processing\. The preview is shown again/)).toBeInTheDocument()
  })

  it('keeps the Basic form, and what is typed in it, while another tab is open', async () => {
    renderPage({ format: 'CSV' })
    expect(await screen.findByTestId('resource-edit-form')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Version history' }))
    // Hidden, not unmounted: unmounting would drop the form's state and an upload
    expect(screen.getByTestId('resource-edit-form')).toBeInTheDocument()
  })

  it('has the list read a reprocess started from the Processing tab', async () => {
    // Otherwise the list's dot, which only polls a run it knows of, stays on "complete"
    reload.mockClear()
    renderPage({ format: 'CSV' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Processing' })).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Processing' }))
    detail.onStarted?.()
    expect(reload).toHaveBeenCalled()
  })

  it('offers no Processing or Table settings tab where nothing may be written', async () => {
    // A deleted dataset's column settings and roles are not read at all
    renderPage({ format: 'CSV' }, { ...pkg, state: 'deleted' })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Basic' })).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: 'Processing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Table settings' })).not.toBeInTheDocument()
  })

  it('treats another dataset’s resource as not found here', async () => {
    renderPage({ format: 'CSV' }, { ...pkg, resources: [] })
    expect(await screen.findByText('Resource not found')).toBeInTheDocument()
  })
})
