import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { ResourceDeleteCard } from '../resource-delete-card'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

describe('ResourceDeleteCard', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('deletes only after the confirmation names the resource', async () => {
    mockClientFetch.mockResolvedValue({ ok: true } as Response)
    const onDeleted = vi.fn()
    render(<ResourceDeleteCard resource={{ id: 'r1', name: 'data.csv' }} onDeleted={onDeleted} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete This Resource' }))
    expect(mockClientFetch).not.toHaveBeenCalled()
    expect(
      screen.getByText('Are you sure you want to delete the resource "data.csv"?')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1', { method: 'DELETE' })
  })

  it('says why when the delete is refused, and stays where it is', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ title: 'FORBIDDEN', status: 403, detail: 'Not allowed here' }),
    } as Response)
    const onDeleted = vi.fn()
    render(<ResourceDeleteCard resource={{ id: 'r1', name: 'data.csv' }} onDeleted={onDeleted} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete This Resource' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Not allowed here')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('waits for a save or an upload under way', () => {
    render(
      <ResourceDeleteCard resource={{ id: 'r1', name: 'data.csv' }} disabled onDeleted={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Delete This Resource' })).toBeDisabled()
  })
})
