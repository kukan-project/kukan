import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { DatasetForm } from '../dataset-form'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}))

// The dialog's own behavior is covered in metadata-suggest-dialog.test.tsx —
// here a stub applies a selection so the form-side wiring is observable. The
// selection is mutable so a test can inject resource adoptions.
const applyState = vi.hoisted(() => ({
  selection: { title: 'AI タイトル', tags: ['防災', '人口'] } as unknown,
}))
vi.mock('../metadata-suggest-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metadata-suggest-dialog')>()),
  MetadataSuggestDialog: ({
    open,
    onApply,
  }: {
    open: boolean
    onApply: (selection: unknown) => void
  }) =>
    open ? (
      <button type="button" onClick={() => onApply(applyState.selection)}>
        MockApplySuggestion
      </button>
    ) : null,
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

/** Mock the on-mount groups fetch plus the submit and publish endpoints */
function setupMocks(submitResponse: Response, publishResponse?: Response) {
  mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes('/api/v1/groups')) return jsonResponse({ items: [] })
    if (path.endsWith('/publish')) return publishResponse ?? jsonResponse({})
    if (init?.method === 'POST' || init?.method === 'PUT') return submitResponse
    return jsonResponse({})
  })
}

function findSubmitCall() {
  return mockClientFetch.mock.calls.find((c) => c[1]?.method === 'POST' || c[1]?.method === 'PUT')
}

const organizations = [{ id: '11111111-1111-4111-8111-111111111111', name: 'org', title: 'Org' }]

describe('DatasetForm (draft flows)', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    push.mockReset()
    applyState.selection = { title: 'AI タイトル', tags: ['防災', '人口'] }
  })

  describe('create mode', () => {
    it('should show non-required labels and a draft submit button', () => {
      setupMocks(jsonResponse({}))
      render(<DatasetForm mode="create" organizations={organizations} />)

      expect(screen.getByText('URL Identifier')).toBeInTheDocument()
      expect(screen.queryByText('URL Identifier (required)')).not.toBeInTheDocument()
      expect(screen.getByText('Organization')).toBeInTheDocument()
      expect(screen.queryByText('Organization (required)')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create Draft' })).toBeInTheDocument()
    })

    it('should POST to /packages/drafts omitting blank name and ownerOrg', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'untitled-abcd1234' }))
      render(<DatasetForm mode="create" organizations={organizations} />)

      fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }))

      await waitFor(() => {
        expect(findSubmitCall()).toBeDefined()
      })
      const [url, init] = findSubmitCall()!
      expect(url).toBe('/api/v1/packages/drafts')
      expect(init!.method).toBe('POST')
      const body = JSON.parse(init!.body as string)
      expect(body).not.toHaveProperty('name')
      expect(body).not.toHaveProperty('ownerOrg')
    })

    it('should include name when filled and redirect to the draft edit page', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'my-dataset' }))
      render(<DatasetForm mode="create" organizations={organizations} />)

      fireEvent.change(screen.getByPlaceholderText('my-dataset'), {
        target: { value: 'my-dataset' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }))

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith('/dashboard/datasets/draft-1/edit?state=draft')
      })
      const body = JSON.parse(findSubmitCall()![1]!.body as string)
      expect(body.name).toBe('my-dataset')
    })

    it('should keep reporting busy after successful creation until unmount', async () => {
      setupMocks(jsonResponse({ id: 'draft-1' }))
      const onBusyChange = vi.fn()
      render(
        <DatasetForm mode="create" organizations={organizations} onBusyChange={onBusyChange} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }))
      await waitFor(() => {
        expect(push).toHaveBeenCalled()
      })

      // isSubmitting drops back to false once the submit resolves, but the
      // navigation is still in flight — the busy report must never re-enable
      // the owner's competing actions (e.g. the drop zone on the new page)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(onBusyChange).toHaveBeenCalledWith(true)
      expect(onBusyChange.mock.calls.at(-1)?.[0]).toBe(true)
      // The submit button also stays disabled through the navigation
      expect(screen.getByRole('button', { name: 'Create Draft' })).toBeDisabled()
    })

    it('should show the error detail when creation fails', async () => {
      setupMocks(jsonResponse({ detail: 'Package name already exists' }, false))
      render(<DatasetForm mode="create" organizations={organizations} />)

      fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Package name already exists')
      })
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('edit mode (draft)', () => {
    it('should keep the name field editable and PUT to the package, then call onSaved', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'renamed' }))
      const onSaved = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '', title: 'WIP' }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )

      const nameInput = screen.getByPlaceholderText('my-dataset')
      expect(nameInput).not.toBeDisabled()
      fireEvent.change(nameInput, { target: { value: 'renamed' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      const [url, init] = findSubmitCall()!
      expect(url).toBe('/api/v1/packages/draft-1')
      expect(init!.method).toBe('PUT')
      expect(JSON.parse(init!.body as string).name).toBe('renamed')
      expect(push).not.toHaveBeenCalled()
    })

    it('should omit a blank name so the server keeps the placeholder', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'untitled-abcd1234' }))
      const onSaved = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '' }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )

      // The pristine form disables Save Draft — make a change first
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'WIP' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      const body = JSON.parse(findSubmitCall()![1]!.body as string)
      expect(body).not.toHaveProperty('name')
    })

    it('should send name: null when clearing a real name and show blank after the reset', async () => {
      // Clearing a previously set name is an explicit reset: the PUT carries
      // name: null and the server responds with a fresh placeholder (ADR-039)
      setupMocks(jsonResponse({ id: 'draft-1', name: 'untitled-abcd1234', ownerOrg: null }))
      const onSaved = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: 'old-name' }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )

      const nameInput = screen.getByPlaceholderText('my-dataset')
      fireEvent.change(nameInput, { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      const body = JSON.parse(findSubmitCall()![1]!.body as string)
      expect(body.name).toBeNull()
      expect(nameInput).toHaveValue('')
    })

    it('should keep the name field empty when the server kept the placeholder', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'untitled-abcd1234', ownerOrg: null }))
      const onSaved = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '' }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'WIP' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      expect(screen.getByPlaceholderText('my-dataset')).toHaveValue('')
    })
  })

  describe('edit mode (draft) — dirty gating', () => {
    function renderDraftEdit(onSaved = vi.fn()) {
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '', title: 'WIP' }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )
      return onSaved
    }

    it('should disable Save Draft on a pristine form and enable it after a change', () => {
      setupMocks(jsonResponse({}))
      renderDraftEdit()

      const saveButton = screen.getByRole('button', { name: 'Save Draft' })
      expect(saveButton).toBeDisabled()

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed' } })
      expect(saveButton).toBeEnabled()
    })

    it('should enable Save Draft when only tags change', () => {
      setupMocks(jsonResponse({}))
      renderDraftEdit()

      const saveButton = screen.getByRole('button', { name: 'Save Draft' })
      expect(saveButton).toBeDisabled()

      fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'stats' } })
      expect(saveButton).toBeEnabled()
    })

    it('should enable Save Draft when only extras change, ignoring empty rows', () => {
      setupMocks(jsonResponse({}))
      renderDraftEdit()

      const saveButton = screen.getByRole('button', { name: 'Save Draft' })
      fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
      // An empty extras row is dropped on submit — not a change yet
      expect(saveButton).toBeDisabled()

      fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'source' } })
      expect(saveButton).toBeEnabled()
    })

    it('should disable Save Draft again after a successful save', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', name: 'untitled-abcd1234', ownerOrg: null }))
      const onSaved = renderDraftEdit()

      fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'stats' } })
      const saveButton = screen.getByRole('button', { name: 'Save Draft' })
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      expect(saveButton).toBeDisabled()
    })
  })

  describe('edit mode (draft) — save & publish', () => {
    const publishReady = {
      name: 'my-data',
      ownerOrg: organizations[0].id,
      licenseId: 'cc-by',
    }

    it('should list every missing precondition and disable the button', () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '' }}
          organizations={organizations}
        />
      )

      expect(screen.getByText('Enter a URL identifier to publish')).toBeInTheDocument()
      expect(screen.getByText('Select an organization to publish')).toBeInTheDocument()
      expect(screen.getByText('Select a license to publish')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save & Publish' })).toBeDisabled()
    })

    it('should enable the button from live form values without saving first', async () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={{ name: '', ownerOrg: publishReady.ownerOrg, licenseId: 'cc-by' }}
          organizations={organizations}
        />
      )

      const publishButton = screen.getByRole('button', { name: 'Save & Publish' })
      expect(publishButton).toBeDisabled()
      expect(screen.getByText('Enter a URL identifier to publish')).toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('my-dataset'), {
        target: { value: 'my-data' },
      })

      await waitFor(() => {
        expect(publishButton).toBeEnabled()
      })
      expect(screen.queryByText('Enter a URL identifier to publish')).not.toBeInTheDocument()
    })

    it('should keep Save & Publish enabled on a pristine but publishable draft', () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={publishReady}
          organizations={organizations}
        />
      )

      // Publishing is an action of its own — no change required
      expect(screen.getByRole('button', { name: 'Save & Publish' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled()
    })

    it('should PUT the draft then POST publish and call onPublished', async () => {
      setupMocks(jsonResponse({ id: 'draft-1', ...publishReady }))
      const onSaved = vi.fn()
      const onPublished = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={publishReady}
          organizations={organizations}
          onSaved={onSaved}
          onPublished={onPublished}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Save & Publish' }))

      await waitFor(() => {
        expect(onPublished).toHaveBeenCalled()
      })
      const calls = mockClientFetch.mock.calls
      const putIndex = calls.findIndex((c) => c[1]?.method === 'PUT')
      const publishIndex = calls.findIndex((c) => (c[0] as string).endsWith('/publish'))
      expect(putIndex).toBeGreaterThanOrEqual(0)
      expect(publishIndex).toBeGreaterThan(putIndex)
      expect(calls[publishIndex][0]).toBe('/api/v1/packages/draft-1/publish')
      expect(calls[publishIndex][1]?.method).toBe('POST')
      // Publish success supersedes the plain save notification
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('should report a publish-only failure while keeping the saved draft editable', async () => {
      setupMocks(
        jsonResponse({ id: 'draft-1', ...publishReady }),
        jsonResponse({ detail: 'Not authorized' }, false)
      )
      const onSaved = vi.fn()
      const onPublished = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          isDraft
          nameOrId="draft-1"
          defaultValues={publishReady}
          organizations={organizations}
          onSaved={onSaved}
          onPublished={onPublished}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Save & Publish' }))

      await waitFor(() => {
        expect(screen.getByText('Saved, but publishing failed: Not authorized')).toBeInTheDocument()
      })
      expect(onPublished).not.toHaveBeenCalled()
      // The save itself landed — the parent still refreshes, and the pristine
      // form disables Save Draft while Save & Publish stays available
      expect(onSaved).toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Save & Publish' })).toBeEnabled()
    })
  })

  describe('edit mode (active)', () => {
    it('should keep the name field disabled and required labels', () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          mode="edit"
          nameOrId="pkg-1"
          defaultValues={{ name: 'active-pkg' }}
          organizations={organizations}
        />
      )

      expect(screen.getByPlaceholderText('my-dataset')).toBeDisabled()
      expect(screen.getByText('URL Identifier (required)')).toBeInTheDocument()
      expect(screen.getByText('Organization (required)')).toBeInTheDocument()
    })

    it('should label the submit button Save and disable it until a change is made', () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          mode="edit"
          nameOrId="pkg-1"
          defaultValues={{
            name: 'active-pkg',
            ownerOrg: organizations[0].id,
            licenseId: 'cc-by',
          }}
          organizations={organizations}
        />
      )

      const saveButton = screen.getByRole('button', { name: 'Save' })
      expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
      expect(saveButton).toBeDisabled()

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed' } })
      expect(saveButton).toBeEnabled()
    })

    it('should PUT the update and disable Save again after a successful save', async () => {
      setupMocks(jsonResponse({ id: 'pkg-1', name: 'active-pkg' }))
      const onSaved = vi.fn()
      render(
        <DatasetForm
          mode="edit"
          nameOrId="pkg-1"
          defaultValues={{
            name: 'active-pkg',
            ownerOrg: organizations[0].id,
            licenseId: 'cc-by',
          }}
          organizations={organizations}
          onSaved={onSaved}
        />
      )

      fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'stats' } })
      const saveButton = screen.getByRole('button', { name: 'Save' })
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled()
      })
      const [url, init] = findSubmitCall()!
      expect(url).toBe('/api/v1/packages/pkg-1')
      expect(init!.method).toBe('PUT')
      expect(saveButton).toBeDisabled()
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('AI metadata suggestions (ADR-040)', () => {
    const editProps = {
      mode: 'edit' as const,
      nameOrId: 'pkg-1',
      defaultValues: { name: 'pkg', ownerOrg: organizations[0].id, licenseId: 'cc-by' },
      organizations,
    }

    it('hides the button without the capability or the suggest prop', () => {
      setupMocks(jsonResponse({}))
      const { rerender } = render(<DatasetForm {...editProps} />)
      expect(
        screen.queryByRole('button', { name: /Suggest metadata with AI/ })
      ).not.toBeInTheDocument()

      rerender(<DatasetForm {...editProps} suggest={{ enabled: false, resources: [] }} />)
      expect(
        screen.queryByRole('button', { name: /Suggest metadata with AI/ })
      ).not.toBeInTheDocument()
    })

    it('disables the button with a hint until a resource pipeline completed', () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          {...editProps}
          suggest={{
            enabled: true,
            resources: [{ id: 'r1', name: 'data.csv', pipelineStatus: 'processing' }],
          }}
        />
      )

      expect(screen.getByRole('button', { name: /Suggest metadata with AI/ })).toBeDisabled()
      expect(screen.getByText(/Upload a resource and the AI can suggest/)).toBeInTheDocument()
    })

    it('opens the dialog and applies the selection into the form fields', async () => {
      setupMocks(jsonResponse({}))
      render(
        <DatasetForm
          {...editProps}
          suggest={{
            enabled: true,
            resources: [{ id: 'r1', name: 'data.csv', pipelineStatus: 'complete' }],
          }}
        />
      )

      const button = screen.getByRole('button', { name: /Suggest metadata with AI/ })
      expect(button).toBeEnabled()
      fireEvent.click(button)
      fireEvent.click(await screen.findByRole('button', { name: 'MockApplySuggestion' }))

      expect(screen.getByLabelText('Title')).toHaveValue('AI タイトル')
      expect(screen.getByLabelText('Tags')).toHaveValue('防災, 人口')
      // Adopted values mark the form dirty so Save enables
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })

    it('surfaces a failure when adopting a resource suggestion does not save', async () => {
      applyState.selection = { resources: [{ id: 'r1', description: 'AI 説明' }] }
      // Resource GET succeeds, its PUT fails → updateResource returns false
      mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path.includes('/api/v1/groups')) return jsonResponse({ items: [] })
        if (path.includes('/api/v1/resources/') && init?.method === 'PUT')
          return jsonResponse({}, false)
        return jsonResponse({ id: 'r1' })
      })
      render(
        <DatasetForm
          {...editProps}
          suggest={{
            enabled: true,
            resources: [{ id: 'r1', name: 'data.csv', pipelineStatus: 'complete' }],
          }}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Suggest metadata with AI/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'MockApplySuggestion' }))

      expect(await screen.findByText(/Failed to update 1 resource/)).toBeInTheDocument()
    })
  })
})
