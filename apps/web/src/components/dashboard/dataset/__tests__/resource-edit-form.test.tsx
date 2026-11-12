import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { ResourceEditForm, type EditableResource } from '../resource-edit-form'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

const uploadZone = vi.hoisted(() => ({ format: undefined as string | undefined }))
vi.mock('../file-upload-zone', () => ({
  FileUploadZone: ({ onComplete, format }: { onComplete?: () => void; format?: string }) => {
    uploadZone.format = format
    return (
      <div data-testid="file-upload-zone">
        <button onClick={onComplete}>complete-upload</button>
      </div>
    )
  },
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

const linked: EditableResource = {
  id: 'r1',
  name: 'data.csv',
  url: 'https://example.com/a.csv',
  urlType: null,
  format: 'CSV',
  extras: { unit: 'persons', year: 2024 },
}

/** Answers the GET updateResource merges over, and the PUT itself */
function serve(resource: EditableResource) {
  mockClientFetch.mockImplementation(async (_url, init) =>
    jsonResponse(init?.method === 'PUT' ? {} : resource)
  )
}

/** Save, and confirm the save where it changes the source or format (ADR-072 decision 6) */
function saveThroughConfirmation() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
}

/** The body of the request made with `method`, parsed */
function sentBody(method: string) {
  const call = mockClientFetch.mock.calls.find(([, init]) => init?.method === method)
  return call && JSON.parse(String(call[1]!.body))
}

function renderForm(
  resource: EditableResource,
  props: Partial<Parameters<typeof ResourceEditForm>[0]> = {}
) {
  return render(<ResourceEditForm resource={resource} onSaved={vi.fn()} {...props} />)
}

describe('ResourceEditForm', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    uploadZone.format = undefined
  })

  it('saves nothing until something changed', () => {
    renderForm(linked)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves the extras whole, and a value it was not asked to change as it was', async () => {
    serve(linked)
    const onSaved = vi.fn()
    renderForm(linked, { onSaved })

    // Not a string: shown, and saved back, as its JSON text
    expect(screen.getByDisplayValue('2024')).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('persons'), { target: { value: 'households' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sentBody('PUT').extras).toEqual({ unit: 'households', year: 2024 })
    // Said, until the next change: a disabled button alone reads as nothing done
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })

  it('refuses a key typed twice before sending anything', () => {
    renderForm(linked)
    fireEvent.click(screen.getByText('+ Add field'))
    const keys = screen.getAllByPlaceholderText('Key')
    fireEvent.change(keys[keys.length - 1], { target: { value: 'unit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('leaves the link live until the file that replaces it has arrived', async () => {
    // The source and format travel with the upload and land at its promotion;
    // written by the save, the download would stop pointing at the link before
    // the file exists — and for good if the upload were abandoned
    serve(linked)
    const onSaved = vi.fn()
    const { container } = renderForm(linked, { onSaved })

    // Radix tabs select on mousedown
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Upload' }))
    // A link holds no file to replace, so the drop zone is there straight away
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'b.tsv', { type: 'text/tab-separated-values' })] },
    })
    fireEvent.change(screen.getByPlaceholderText('Auto-detected from URL or file'), {
      target: { value: 'TSV' },
    })
    saveThroughConfirmation()

    await waitFor(() => expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument())
    const body = sentBody('PUT')
    expect(body.urlType).toBeNull()
    expect(body.url).toBe('https://example.com/a.csv')
    expect(uploadZone.format).toBe('TSV')

    // The page reads the resource back once the file has landed
    expect(onSaved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('complete-upload'))
    expect(onSaved).toHaveBeenCalled()
  })

  it('turns an upload back into a link when the link tab is saved', async () => {
    // A link is a null type; leaving it out kept the row an upload with a URL
    const upload: EditableResource = {
      id: 'r1',
      name: 'data.csv',
      url: 'data.csv',
      urlType: 'upload',
      format: 'CSV',
    }
    serve(upload)
    renderForm(upload)

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'External URL' }))
    fireEvent.change(screen.getByPlaceholderText('https://example.com/data.csv'), {
      target: { value: 'https://example.com/b.csv' },
    })
    saveThroughConfirmation()

    await waitFor(() => expect(sentBody('PUT')).toBeDefined())
    expect(sentBody('PUT').urlType).toBeNull()
    expect(sentBody('PUT').url).toBe('https://example.com/b.csv')
  })

  it('keeps what is being typed when the same resource is read again', () => {
    // A run settling reads the resource back; the copy is new, the content is not
    const { rerender } = renderForm(linked)
    fireEvent.change(screen.getByDisplayValue('persons'), { target: { value: 'households' } })
    rerender(<ResourceEditForm resource={{ ...linked }} onSaved={vi.fn()} />)
    expect(screen.getByDisplayValue('households')).toBeInTheDocument()
  })

  it('will not save a link as an upload without a file', () => {
    // It would be an upload named after its old URL, with nothing to serve
    renderForm(linked)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Upload' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(
      screen.getByText('Choose a file to switch this resource to an upload.')
    ).toBeInTheDocument()
  })

  it('comes back to the fields from an upload that was cancelled or failed', async () => {
    serve({ ...linked, urlType: 'upload', url: 'data.csv' })
    const onSaved = vi.fn()
    const { container } = renderForm({ ...linked, urlType: 'upload', url: 'data.csv' }, { onSaved })
    fireEvent.click(screen.getByText('Replace file'))
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['a'], 'b.csv', { type: 'text/csv' })] },
    })
    saveThroughConfirmation()
    await waitFor(() => expect(screen.getByTestId('file-upload-zone')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Back to the fields' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(onSaved).toHaveBeenCalled()
  })

  it('saves a new name without asking: it makes no version', async () => {
    serve(linked)
    const onSaved = vi.fn()
    renderForm(linked, { onSaved })
    fireEvent.change(screen.getByDisplayValue('data.csv'), { target: { value: 'renamed.csv' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says a new format makes a version, and saves nothing until confirmed', () => {
    renderForm(linked)
    fireEvent.change(screen.getByPlaceholderText('Auto-detected from URL or file'), {
      target: { value: 'TSV' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Changing the format creates one version.')
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('says a new link makes a version only if what it holds differs', () => {
    renderForm(linked)
    fireEvent.change(screen.getByDisplayValue('https://example.com/a.csv'), {
      target: { value: 'https://example.com/b.csv' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(/if the contents differ/)
  })
})
