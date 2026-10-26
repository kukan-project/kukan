import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { DataResetCard } from '../data-reset-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function mockFetchResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response
}

describe('DataResetCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the card with its warning', () => {
    render(<DataResetCard />)
    expect(screen.getByText('Data Reset')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will permanently delete all datasets, resources, organizations, groups, tags, pipeline jobs, and associated files. User accounts will be preserved.'
      )
    ).toBeInTheDocument()
  })

  it('has confirm input and disabled button by default', () => {
    render(<DataResetCard />)
    const input = screen.getByPlaceholderText('RESET')
    expect(input).toBeInTheDocument()

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    expect(button).toBeDisabled()
  })

  it('enables button when RESET is typed', () => {
    render(<DataResetCard />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    expect(button).toBeEnabled()
  })

  it('shows result after successful reset', async () => {
    mockClientFetch.mockResolvedValue(
      mockFetchResponse({
        deleted: {
          packages: 5,
          organizations: 2,
          groups: 3,
          tags: 10,
          storageObjects: 8,
        },
      })
    )

    render(<DataResetCard />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('Reset Complete')).toBeInTheDocument()
    })

    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/data', { method: 'DELETE' })
    // The typed confirmation is cleared, so a second run has to be typed again
    expect(button).toBeDisabled()
  })

  it('shows error on failed reset', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response)

    render(<DataResetCard />)
    const input = screen.getByPlaceholderText('RESET')
    fireEvent.change(input, { target: { value: 'RESET' } })

    const button = screen.getByRole('button', { name: /Delete All Data/ })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText('500: Internal Server Error')).toBeInTheDocument()
    })
  })
})
