import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { PipelineStatusBadge } from '../pipeline-status-badge'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
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

  it('should show error badge and ask once for the reason, without polling', async () => {
    // The one terminal status that does fetch: the reason lives behind the
    // status endpoint, which is also what decides who may read it. Asked once
    // — the difference from polling, which is what this used to assert.
    mockClientFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ pipeline_status: 'error', error: 'Failed to fetch: 403', steps: [] })
      )
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="error" />)

    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(await screen.findByText('Failed to fetch: 403')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
  })

  it('should fall back to the first step that carries an error', async () => {
    // A failure is recorded on the step that hit it and only sometimes copied
    // up, so the row would say nothing for the ordinary case.
    mockClientFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          pipeline_status: 'error',
          error: null,
          steps: [
            { step_name: 'fetch', error: null },
            { step_name: 'interpret', error: 'Unsupported encoding' },
          ],
        })
      )
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="error" />)

    expect(await screen.findByText('Unsupported encoding')).toBeInTheDocument()
  })

  it('should still show the badge when the reason cannot be fetched', async () => {
    // The status is known from the list; a reason nobody could retrieve is not
    // worth failing the row over.
    mockClientFetch.mockRejectedValue(new Error('offline'))

    render(<PipelineStatusBadge resourceId="r1" initialStatus="error" />)

    expect(screen.getByText('Error')).toBeInTheDocument()
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

  it('should read the reason from the poll that saw the failure, without asking again', async () => {
    // A row that fails while the page is open already has the answer: the poll
    // that observed it read the same body the reason lives in. Asking again
    // would be a second request for data in hand.
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'error',
        error: 'Failed to fetch: 403',
        steps: [],
      })
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)

    expect(await screen.findByText('Failed to fetch: 403')).toBeInTheDocument()
    // One poll, and no follow-up for something it already returned.
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
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

  it('should say when a completed run stored no new version', async () => {
    // Re-uploading the same bytes completes with the Version step skipped, so
    // the history does not move — without the note, the run looks like it did
    // nothing at all
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [{ step_name: 'version', status: 'skipped' }],
      })
    )

    const { rerender } = render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)

    expect(
      await screen.findByText('No new version — the file matches the content already stored')
    ).toBeInTheDocument()

    // The note has to survive the parent's refetch, which settles the row and
    // stops the polling that observed the skip
    rerender(<PipelineStatusBadge resourceId="r1" initialStatus="complete" />)
    expect(
      screen.getByText('No new version — the file matches the content already stored')
    ).toBeInTheDocument()
  })

  it('should say so for a run that was over before the badge saw it', async () => {
    // A run with nothing to derive settles in tens of milliseconds, so the
    // refetch after an upload hands the badge a finished run: there is no
    // queued status to poll from, and the note has to be asked for
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [{ step_name: 'version', status: 'skipped' }],
      })
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="complete" justRan />)

    expect(
      await screen.findByText('No new version — the file matches the content already stored')
    ).toBeInTheDocument()
  })

  it('should not ask about a completed run nobody started here', async () => {
    // Every row of a listing would otherwise ask, on every load
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [{ step_name: 'version', status: 'skipped' }],
      })
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="complete" />)

    await waitFor(() => expect(screen.getByText('Complete')).toBeInTheDocument())
    expect(mockClientFetch).not.toHaveBeenCalled()
  })

  it('should not carry the no-new-version note into the next run', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [{ step_name: 'version', status: 'skipped' }],
      })
    )
    const { rerender } = render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)
    await screen.findByText('No new version — the file matches the content already stored')
    rerender(<PipelineStatusBadge resourceId="r1" initialStatus="complete" />)

    // A new run starts. The poller still holds the previous run's data, so the
    // note has to be dropped on the transition rather than on what it reads.
    mockClientFetch.mockResolvedValue(
      jsonResponse({ id: 'r1', pipeline_status: 'processing', steps: [] })
    )
    rerender(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)

    expect(
      screen.queryByText('No new version — the file matches the content already stored')
    ).not.toBeInTheDocument()
  })

  it('should not say anything when the run did store a version', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        id: 'r1',
        pipeline_status: 'complete',
        steps: [{ step_name: 'version', status: 'complete' }],
      })
    )

    render(<PipelineStatusBadge resourceId="r1" initialStatus="queued" />)

    await waitFor(() => expect(screen.getByText('Complete')).toBeInTheDocument())
    expect(
      screen.queryByText('No new version — the file matches the content already stored')
    ).not.toBeInTheDocument()
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
