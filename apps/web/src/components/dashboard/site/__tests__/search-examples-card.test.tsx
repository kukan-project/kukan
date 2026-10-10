import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { SearchExamplesCard } from '../search-examples-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function respond(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response
}

async function renderLoaded(queries: string[] = ['shelters', 'free wifi']) {
  mockClientFetch.mockResolvedValueOnce(respond({ 'search-example-queries': queries }))
  render(<SearchExamplesCard />)
  await screen.findByText('Example Search Queries')
}

function putBody() {
  const call = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PUT')
  return JSON.parse(call![1]!.body as string).value
}

describe('SearchExamplesCard', () => {
  beforeEach(() => {
    // Reset, not clear: a failed test can leave a queued response for the next one
    mockClientFetch.mockReset()
  })

  it('should show one row per stored query, in order', async () => {
    await renderLoaded()
    expect(screen.getByLabelText('Example query 1')).toHaveValue('shelters')
    expect(screen.getByLabelText('Example query 2')).toHaveValue('free wifi')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('should save the rows reordered, trimmed and without blank ones', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.change(screen.getByLabelText('Example query 4'), { target: { value: ' parks ' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0])
    mockClientFetch.mockResolvedValueOnce(respond({ value: ['free wifi', 'shelters', 'parks'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual(['free wifi', 'shelters', 'parks'])
    // The response replaces the rows, so the blank one is gone
    expect(screen.queryByLabelText('Example query 4')).not.toBeInTheDocument()
  })

  it('should not count a blank row as a change', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('should save an empty list to hide the chips', async () => {
    await renderLoaded(['shelters'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove row' }))
    expect(screen.getByText(/No example queries/)).toBeInTheDocument()
    mockClientFetch.mockResolvedValueOnce(respond({ value: [] }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual([])
  })

  it('should stop adding rows at the limit', async () => {
    await renderLoaded(Array.from({ length: 10 }, (_, i) => `query ${i}`))
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled()
  })

  it('should freeze the rows while a save is in flight', async () => {
    await renderLoaded()
    let finish!: (res: Response) => void
    mockClientFetch.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    fireEvent.change(screen.getByLabelText('Example query 1'), { target: { value: 'parks' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByLabelText('Example query 1')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled()
    finish(respond({ value: ['parks', 'free wifi'] }))
    await screen.findByRole('status')
    expect(screen.getByLabelText('Example query 1')).toBeEnabled()
  })
})
