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

  it('renders a run that was stopped, and does not poll for it', () => {
    // `cancelled` reaches this component from an ordinary flow — replacing a
    // file while a run is in flight (ADR-044 §4). Rendering it as a missing key
    // would crash the badge, and treating it as unsettled would poll forever.
    render(<PipelineStatusBadge resourceId="r1" initialStatus="cancelled" />)
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    expect(mockClientFetch).not.toHaveBeenCalled()
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

  it('should notify onSettled even when the first poll is already terminal', async () => {
    // Otherwise the owner keeps gating on its stale queued/processing snapshot
    mockClientFetch.mockResolvedValue(
      jsonResponse({ id: 'r1', pipeline_status: 'complete', steps: [] })
    )
    const onSettled = vi.fn()
    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" onSettled={onSettled} />)

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('complete'))
  })

  it('should notify onSettled when polling reaches complete', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', pipeline_status: 'processing', steps: [] }))
      .mockResolvedValue(jsonResponse({ id: 'r1', pipeline_status: 'complete', steps: [] }))
    const onSettled = vi.fn()
    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" onSettled={onSettled} />)

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('complete'), { timeout: 3000 })
  })

  it('should notify onSettled when polling reaches error', async () => {
    // Errors must notify too — owners tracking outstanding work would
    // otherwise wait forever on a failed pipeline
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', pipeline_status: 'processing', steps: [] }))
      .mockResolvedValue(jsonResponse({ id: 'r1', pipeline_status: 'error', steps: [] }))
    const onSettled = vi.fn()
    render(<PipelineStatusBadge resourceId="r1" initialStatus="processing" onSettled={onSettled} />)

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('error'), { timeout: 3000 })
  })

  it('should show the prop status when a parent refetch settles before polling does', async () => {
    // Bulk-upload regression: the parent list refetches and passes a terminal
    // initialStatus while the poller still holds queued/processing — polling
    // gets disabled and the badge must not stay stuck on the stale poll data
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'processing',
        steps: [],
      })
    )

    const { rerender } = render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)
    await waitFor(() => {
      expect(screen.getByText('Processing')).toBeInTheDocument()
    })

    rerender(<PipelineStatusBadge resourceId="r1" initialStatus="complete" />)
    expect(screen.getByText('Complete')).toBeInTheDocument()
  })
})
