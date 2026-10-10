import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { SiteMetadataCard } from '../site-metadata-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function respond(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as Response
}

const stored = [
  { key: 'population', type: 'number', value: 123456 },
  { key: 'population-as-of', type: 'date', value: '2026-06-01' },
  { key: 'tagline', type: 'text', value: { ja: '探す', en: 'Find' } },
]

async function renderLoaded(entries: unknown[] = stored) {
  mockClientFetch.mockResolvedValueOnce(respond({ 'site-metadata': entries }))
  render(<SiteMetadataCard />)
  await screen.findByText('Site Metadata')
}

function putBody() {
  const call = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PUT')
  return JSON.parse(call![1]!.body as string).value
}

describe('SiteMetadataCard', () => {
  beforeEach(() => {
    // Reset, not clear: a failed test can leave a queued response for the next one
    mockClientFetch.mockReset()
  })

  it('should show each stored entry with an input fitting its type', async () => {
    await renderLoaded()

    const keys = screen.getAllByLabelText('Key').map((input) => (input as HTMLInputElement).value)
    expect(keys).toEqual(['population', 'population-as-of', 'tagline'])
    expect(screen.getByDisplayValue('123456')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-06-01')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Value (Japanese)')).toHaveValue('探す')
    expect(screen.getByLabelText('Value (English)')).toHaveValue('Find')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('should save the rows in their new order', async () => {
    await renderLoaded()
    mockClientFetch.mockResolvedValueOnce(respond({ value: [stored[1], stored[0], stored[2]] }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual([stored[1], stored[0], stored[2]])
  })

  it('should keep a per-language text as stored when another row is saved', async () => {
    const entries = [
      { key: 'population', type: 'number', value: 1 },
      { key: 'tagline', type: 'text', value: { ja: '', en: ' Find ' } },
      { key: 'blank', type: 'text', value: { ja: '', en: '' } },
    ]
    await renderLoaded(entries)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    mockClientFetch.mockResolvedValueOnce(respond({ value: entries }))

    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual([{ ...entries[0], value: 2 }, entries[1], entries[2]])
  })

  it('should drop a language whose field is cleared', async () => {
    await renderLoaded([{ key: 'tagline', type: 'text', value: { ja: '探す', en: 'Find' } }])
    mockClientFetch.mockResolvedValueOnce(respond({ value: [] }))

    fireEvent.change(screen.getByLabelText('Value (Japanese)'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual([{ key: 'tagline', type: 'text', value: { en: 'Find' } }])
  })

  it('should send a number as a number', async () => {
    await renderLoaded([])
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'households' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '-12' } })
    mockClientFetch.mockResolvedValueOnce(respond({ value: [] }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(putBody()).toEqual([{ key: 'households', type: 'number', value: -12 }])
    )
  })

  it('should hold the save back while a key is repeated or malformed', async () => {
    await renderLoaded()
    const [, second] = screen.getAllByLabelText('Key')

    fireEvent.change(second, { target: { value: 'population' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText(/Check the entries/)).toBeInTheDocument()

    fireEvent.change(second, { target: { value: 'Population As Of' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(second, { target: { value: 'as-of' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('should freeze the rows while a save is in flight', async () => {
    await renderLoaded()
    let finish!: (res: Response) => void
    mockClientFetch.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))

    fireEvent.change(screen.getByDisplayValue('123456'), { target: { value: '123457' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The response replaces every row, so nothing may be edited before it lands
    expect(screen.getByDisplayValue('123457')).toBeDisabled()
    expect(screen.getAllByLabelText('Key')[0]).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Remove row' })[0]).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled()

    finish(respond({ value: [{ ...stored[0], value: 123457 }, stored[1], stored[2]] }))
    await screen.findByRole('status')
    expect(screen.getByDisplayValue('123457')).toBeEnabled()
  })

  it('should show why the server refused the save', async () => {
    await renderLoaded()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0])
    mockClientFetch.mockResolvedValueOnce(
      respond({ detail: 'Duplicate key: tagline', status: 400 }, false, 400)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate key: tagline')
  })
})
