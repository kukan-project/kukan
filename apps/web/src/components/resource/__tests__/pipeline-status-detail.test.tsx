import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePipelineStatus } from '@/hooks/use-pipeline-status'
import { PipelineStatusDetail } from '../pipeline-status-detail'

vi.mock('@/lib/client-api', () => ({ clientFetch: vi.fn() }))
vi.mock('@/hooks/use-pipeline-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-pipeline-status')>()),
  usePipelineStatus: vi.fn(),
}))

const mockFetch = vi.mocked(clientFetch)
const mockStatus = vi.mocked(usePipelineStatus)
const refetch = vi.fn()

/** `hasContent` as the server says it: a file held unless told otherwise */
function showing(status: string, steps: unknown[] = [], hasContent: boolean | undefined = true) {
  mockStatus.mockReturnValue({
    status,
    steps,
    error: null,
    revertTarget: 1,
    liveRevision: 'rev-1',
    hasContent,
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
      json: async () => ({ restored: 1, cleared: true, queued: false }),
    } as Response)
    showing('processing', [runningStep(5)])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    const confirm = screen
      .getAllByRole('button', { name: /Stop and revert/ })
      .find((b) => b.closest('[role="dialog"]'))!
    fireEvent.click(confirm)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/without fetching from the URL again/)
    expect(alert).toHaveTextContent(/do not revert again/i)
  })

  it('reprocesses without fetching unless asked, needing nothing remembered', async () => {
    // This view lives in a dialog. A revert whose rebuild fails later leaves
    // whoever comes back — a reload, another admin — with only this screen,
    // and fetching an external URL again undoes the revert. So the press, as
    // it stands, is the repair (ADR-044 §4).
    showing('complete')
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /^Reprocess$/ }))

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
      json: async () => ({ restored: 1, cleared: true, queued: false }),
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

    // The run has stopped, so the repair control is offered. Same shape as the
    // revert: nothing to clear because there was content to rebuild, and the
    // enqueue that half is is what failed.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ queued: false, cleared: null }),
    } as Response)
    showing('complete', [])
    rerender(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /^Reprocess$/ }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })

  it('clears the warning once the repair has a job on its way', async () => {
    // The counterpart: `queued` is the whole of what the content path does, so
    // holding the warning past a successful enqueue would leave it up for good
    // — nothing later in this view retracts it.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ restored: 1, cleared: true, queued: false }),
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

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ queued: true, cleared: null }),
    } as Response)
    showing('complete', [])
    rerender(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /^Reprocess$/ }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('does not warn when a half of the outcome had nothing to do', async () => {
    // Emptying the resource leaves no content to rebuild from, so `queued` is
    // null — the ladder's "nothing owed here", not a failure. Read as one, this
    // would put a warning on a revert that finished, pointing at a repair with
    // nothing to repair.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ restored: null, cleared: true, queued: null }),
    } as Response)
    showing('processing', [runningStep(5)])
    render(<PipelineStatusDetail resourceId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /Stop and revert/ })
        .find((b) => b.closest('[role="dialog"]'))!
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names the content that was never saved as a version', async () => {
    // The case worth calling out: replacing the file loses it for good, and
    // nothing else on this screen would say so (ADR-044 §4).
    showing('cancelled', [runningStep(5)])

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.getByText(/before this resource's current content was saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reprocess$/ })).toBeInTheDocument()
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

  it('fetches the file from its URL again only when that is ticked', async () => {
    showing('complete')

    render(<PipelineStatusDetail resourceId="r1" />)
    const option = screen.getByRole('checkbox', { name: /Fetch the file from its URL again/ })
    expect(option).not.toBeChecked()
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: /^Reprocess$/ }))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/resources/r1/run-pipeline',
        expect.not.objectContaining({ body: expect.anything() })
      )
    )
  })

  it('fetches again by default where the resource holds no file to rebuild from', async () => {
    // A URL never fetched: rebuilding alone would have nothing to work from
    showing('error', [], false)

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(
      screen.getByRole('checkbox', { name: /Fetch the file from its URL again/ })
    ).toBeChecked()
  })

  it.each([
    // Read before the status has loaded: a press must not fetch on a guess
    ['until the server has answered', undefined],
    // A revert whose rebuild never ran leaves the stopped run's steps showing,
    // its fetch unfinished; the file it put back is what must not be fetched over
    ['where a file is held, whatever the last run did', true],
  ])('does not fetch by default %s', async (_label, hasContent) => {
    showing('cancelled', [runningStep(5)], hasContent)

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(
      screen.getByRole('checkbox', { name: /Fetch the file from its URL again/ })
    ).not.toBeChecked()
  })

  it('forgets a tick to fetch once a revert has landed', async () => {
    // Ticked, then the run stopped and reverted: kept, the tick would have the
    // next press fetch over the content the revert put back
    const option = () => screen.getByRole('checkbox', { name: /Fetch the file from its URL again/ })
    showing('complete')
    const { rerender } = render(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(option())
    expect(option()).toBeChecked()

    showing('processing', [runningStep(5)])
    rerender(<PipelineStatusDetail resourceId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Stop and revert/ }))
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /Stop and revert/ })
        .find((b) => b.closest('[role="dialog"]'))!
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    showing('complete')
    rerender(<PipelineStatusDetail resourceId="r1" />)
    await waitFor(() => expect(option()).not.toBeChecked())
  })

  it('offers an upload no fetch, there being no source to fetch again', async () => {
    showing('error', [], false)

    render(<PipelineStatusDetail resourceId="r1" uploaded />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Fetching from the URL again/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Reprocess$/ }))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/resources/r1/run-pipeline',
        expect.objectContaining({ body: JSON.stringify({ rebuildOnly: true }) })
      )
    )
  })

  it('offers no stop button once nothing is running', async () => {
    showing('complete')

    render(<PipelineStatusDetail resourceId="r1" />)

    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })
})
