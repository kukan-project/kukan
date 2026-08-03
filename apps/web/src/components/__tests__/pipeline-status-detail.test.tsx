import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePipelineStatus } from '@/hooks/use-pipeline-status'
import { PipelineStatusDetail } from '../pipeline-status-detail'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
vi.mock('@/hooks/use-pipeline-status', () => ({ usePipelineStatus: vi.fn() }))

const mockFetch = vi.mocked(clientFetch)
const mockStatus = vi.mocked(usePipelineStatus)
const refetch = vi.fn()

function showing(status: string, steps: unknown[] = []) {
  mockStatus.mockReturnValue({
    status,
    steps,
    error: null,
    revertTarget: 1,
    liveRevision: 'rev-1',
    refetch,
  } as unknown as ReturnType<typeof usePipelineStatus>)
}

/** A step that began `secondsAgo` ago and has not finished. */
function runningStep(secondsAgo: number) {
  return {
    id: 's1',
    step_name: 'interpret',
    status: 'running',
    error: null,
    started_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    completed_at: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
})

describe('PipelineStatusDetail', () => {
  it('shows how long the run has been going', async () => {
    // The number is there to tell a run that is working from one that is
    // wedged, which is what an operator decides a kill on (ADR-044 §4).
    showing('processing', [runningStep(90)])

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.getByText(/1m/)).toBeInTheDocument()
  })

  it('labels a step name runs no longer write', async () => {
    // `extract` became `interpret` with the stage (ADR-046), but a resource
    // keeps its old rows until it runs again — steps are cleared at the start
    // of a run, not by the rename. Unlabelled, the history shows a raw id.
    showing('complete', [runningStep(5), { ...runningStep(5), id: 's2', step_name: 'extract' }])

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.getByText('Interpret')).toBeInTheDocument()
    expect(screen.getByText('Extract')).toBeInTheDocument()
  })

  it('stops the run without touching the content', async () => {
    showing('processing', [runningStep(5)])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop$/ }))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/resources/r1/cancel-pipeline', {
        method: 'POST',
      })
    )
  })

  it('asks before reverting, because it replaces the live file', async () => {
    showing('processing', [runningStep(5)])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))

    // Nothing sent yet — the dialog is the confirmation.
    expect(mockFetch).not.toHaveBeenCalled()
    await screen.findByText(/goes back to its most recent saved version/)

    // The dialog's own confirm button, not the one that opened it.
    const confirm = screen
      .getAllByRole('button', { name: /Stop and revert/ })
      .find((b) => b.closest('[role="dialog"]'))!
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/resources/r1/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Both echoed back: the destination makes a resend land in the same
        // place, the generation refuses one the resource has moved past.
        body: JSON.stringify({ restoreTo: 1, ifLiveRevision: 'rev-1' }),
      })
    )
  })

  it('sends the revert it showed, not what polling moved to since', async () => {
    // The dialog is the confirmation, so what it was opened against is what the
    // user agreed to. Reading the target again at confirm time can retract
    // content they were never shown (ADR-044 §4).
    showing('processing', [runningStep(5)])
    const { rerender } = render(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    await screen.findByText(/goes back to its most recent saved version/)

    // A poll lands while the dialog is open: newer content, newer generation.
    mockStatus.mockReturnValue({
      status: 'processing',
      steps: [runningStep(5)],
      error: null,
      revertTarget: 2,
      liveRevision: 'rev-2',
      refetch,
    } as unknown as ReturnType<typeof usePipelineStatus>)
    rerender(<PipelineStatusDetail resourceId="r1" />)

    const confirm = screen
      .getAllByRole('button', { name: /Stop and revert/ })
      .find((b) => b.closest('[role="dialog"]'))!
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/resources/r1/revert',
        expect.objectContaining({
          body: JSON.stringify({ restoreTo: 1, ifLiveRevision: 'rev-1' }),
        })
      )
    )
  })

  it('says the revert left work behind, and points away from reverting again', async () => {
    // The content is back; only the rebuild is unfinished. Another revert would
    // step the content back a second time, so the message names the rebuild
    // control instead (ADR-044 §4).
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ cleanedUp: false, restored: 1 }),
    } as Response)
    showing('processing', [runningStep(5)])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    const confirm = screen
      .getAllByRole('button', { name: /Stop and revert/ })
      .find((b) => b.closest('[role="dialog"]'))!
    fireEvent.click(confirm)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Rebuild preview & index/)
    expect(alert).toHaveTextContent(/do not revert again/i)
  })

  it('offers a rebuild that fetches nothing, without needing anything remembered', async () => {
    // This view lives in a dialog. A revert whose rebuild fails later leaves
    // whoever comes back — a reload, another admin — with only the plain
    // reprocess, which re-reads an external URL and undoes the revert. The
    // repair has to be reachable from the screen alone (ADR-044 §4).
    showing('complete', [])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Rebuild preview & index/ }))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/resources/r1/run-pipeline',
        expect.objectContaining({ body: JSON.stringify({ rebuildOnly: true }) })
      )
    )
  })

  it('keeps the warning up when the repair reports work still outstanding', async () => {
    // Clearing it on the way in would take the only pointer to the problem with
    // it, leaving nothing to say the resource still has retracted text indexed.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ cleanedUp: false, restored: 1 }),
    } as Response)
    showing('processing', [runningStep(5)])
    const { rerender } = render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /Stop and revert/ })
        .find((b) => b.closest('[role="dialog"]'))!
    )
    await screen.findByRole('alert')

    // The run has stopped, so the repair control is offered.
    showing('complete', [])
    rerender(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Rebuild preview & index/ }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })

  it('names the content that was never saved as a version', async () => {
    // The case worth calling out: replacing the file loses it for good, and
    // nothing else on this screen would say so (ADR-044 §4).
    showing('cancelled', [runningStep(5)])

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.getByText(/before this resource's current content was saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reprocess/ })).toBeInTheDocument()
  })

  it('does not claim the content is unsaved when the Version step settled it', async () => {
    // Killed during Lake or Index: the version exists, and only the derivatives
    // after it are missing. Saying otherwise would be false.
    showing('cancelled', [
      { ...runningStep(60), step_name: 'version', status: 'complete', completed_at: null },
    ])

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.getByText(/preview and search content may be missing/)).toBeInTheDocument()
  })

  it('offers no stop button once nothing is running', async () => {
    showing('complete')

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })
})
