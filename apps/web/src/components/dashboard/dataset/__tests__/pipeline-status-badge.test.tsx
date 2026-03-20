import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { PipelineStatusBadge } from '../pipeline-status-badge'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('PipelineStatusBadge', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('should render nothing when no status', () => {
    const { container } = render(<PipelineStatusBadge resourceId="r1" initialStatus={null} />)
    expect(container.textContent).toBe('')
  })

  it('should show queued badge', () => {
    // Don't poll (initial status not queued/processing context is tested separately)
    mockClientFetch.mockReturnValue(new Promise(() => {}))
    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('should show processing badge', () => {
    mockClientFetch.mockReturnValue(new Promise(() => {}))
    render(<PipelineStatusBadge resourceId="r1" initialStatus="processing" />)
    expect(screen.getByText('Processing')).toBeInTheDocument()
  })

  it('should show complete badge without polling', () => {
    render(<PipelineStatusBadge resourceId="r1" initialStatus="complete" />)
    expect(screen.getByText('Complete')).toBeInTheDocument()
    // Should not poll for complete status
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('should show error badge without polling', () => {
    render(<PipelineStatusBadge resourceId="r1" initialStatus="error" />)
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('should update from queued to complete via polling', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [],
      })
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)

    // Initially shows queued
    expect(screen.getByText('Queued')).toBeInTheDocument()

    // After polling, should show complete
    await waitFor(() => {
      expect(screen.getByText('Complete')).toBeInTheDocument()
    })
  })
})
