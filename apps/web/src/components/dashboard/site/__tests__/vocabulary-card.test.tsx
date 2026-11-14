import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { VocabularyCard } from '../vocabulary-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function respond(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response
}

async function renderLoaded(packs: string[]) {
  mockClientFetch.mockResolvedValueOnce(respond({ 'vocabulary-packs': packs }))
  render(<VocabularyCard />)
  await screen.findByText('Column vocabulary')
}

function putBody() {
  const call = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PUT')
  return JSON.parse(call![1]!.body as string).value
}

describe('VocabularyCard', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('lists the packs the product ships, none checked by default', async () => {
    await renderLoaded([])
    expect(screen.getByLabelText('Japan (local government codes)')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves the packs checked', async () => {
    await renderLoaded([])
    fireEvent.click(screen.getByLabelText('Japan (local government codes)'))
    mockClientFetch.mockResolvedValueOnce(respond({ value: ['JP'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual(['JP'])
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps a pack a newer release wrote when one listed is unchecked', async () => {
    await renderLoaded(['JP', 'TW'])
    fireEvent.click(screen.getByLabelText('Japan (local government codes)'))
    mockClientFetch.mockResolvedValueOnce(respond({ value: ['TW'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(putBody()).toEqual(['TW'])
  })
})
