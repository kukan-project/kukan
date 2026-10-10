import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { EmbeddingBackfillNotice } from '../embedding-backfill-notice'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const sysadmin = { id: 'u1', email: 'a@example.com', name: 'admin', sysadmin: true }
const viewer = { ...sysadmin, sysadmin: false }
let user = sysadmin

vi.mock('@/components/dashboard/user-provider', () => ({
  useUser: () => user,
}))

function mockStatus(body: unknown) {
  vi.mocked(clientFetch).mockResolvedValue({ ok: true, json: async () => body } as Response)
}

describe('EmbeddingBackfillNotice', () => {
  beforeEach(() => {
    vi.mocked(clientFetch).mockReset()
    user = sysadmin
  })

  it('prompts while resources are outside semantic search', async () => {
    mockStatus({ missing: 12 })

    render(<EmbeddingBackfillNotice />)

    expect(await screen.findByRole('button')).toBeInTheDocument()
    expect(screen.getByText(/12/)).toBeInTheDocument()
  })

  it('stays out of the way once every resource is embedded', async () => {
    mockStatus({ missing: 0 })

    render(<EmbeddingBackfillNotice />)

    await waitFor(() => expect(clientFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  describe('once the work is queued', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    /**
     * The status as the jobs work through it: the page's read, then one answer
     * per poll, the last repeating — each poll's `pollMs` late. As the API
     * answers: regenerating marks what it queues, so from the first poll on
     * those are no longer `missing`, only `outstanding`.
     */
    function mockProgress([first, ...polls]: number[], pollMs = 0) {
      let reads = 0
      vi.mocked(clientFetch).mockImplementation(async (_path, init) => {
        if (init?.method === 'POST') return { ok: true } as Response
        const body =
          reads === 0
            ? { missing: first, outstanding: first }
            : { missing: 0, outstanding: polls[Math.min(reads, polls.length) - 1] }
        if (reads++ > 0) await new Promise((resolve) => setTimeout(resolve, pollMs))
        return { ok: true, json: async () => body } as Response
      })
    }
    /** A second at a time: React runs the effects an update queues when each `act` ends */
    async function elapse(ms: number) {
      for (let t = 0; t < ms; t += 1_000) await act(() => vi.advanceTimersByTimeAsync(1_000))
    }
    /**
     * A second at a time until `check` passes, for at most `ms`: a poll lands a
     * tick or two after it fires, depending on how the timers line up
     */
    async function elapseUntil(ms: number, check: () => void) {
      for (let t = 0; ; t += 1_000) {
        try {
          return check()
        } catch (err) {
          if (t >= ms) throw err
        }
        await act(() => vi.advanceTimersByTimeAsync(1_000))
      }
    }
    const statusReads = () =>
      vi.mocked(clientFetch).mock.calls.filter(([, init]) => init?.method !== 'POST').length

    async function pressAndWait() {
      render(<EmbeddingBackfillNotice />)
      fireEvent.click(await screen.findByRole('button'))
      await screen.findByRole('status')
    }

    it('reads nothing again before the button is pressed', async () => {
      mockProgress([12])
      render(<EmbeddingBackfillNotice />)
      await screen.findByRole('button')

      await elapse(60_000)
      expect(statusReads()).toBe(1)
    })

    it('follows the count down, and goes when nothing is left', async () => {
      mockProgress([12, 5, 0])
      await pressAndWait()

      await elapseUntil(20_000, () => expect(screen.getByText(/5/)).toBeInTheDocument())
      await elapseUntil(20_000, () => expect(screen.queryByRole('button')).not.toBeInTheDocument())

      // Gone, and with it the polling
      const reads = statusReads()
      await elapse(60_000)
      expect(statusReads()).toBe(reads)
    })

    it('waits for a status slower than the interval, rather than cutting it off', async () => {
      mockProgress([12, 0], 20_000)
      await pressAndWait()

      // The poll fires at 15 s and its answer lands at 35 s: none after it may
      // start before then, and the answer it waited for is the one shown
      await elapse(34_000)
      expect(statusReads()).toBe(2)
      await elapseUntil(5_000, () => expect(screen.queryByRole('button')).not.toBeInTheDocument())
    })
  })

  it('asks nothing of a viewer who could not act on the answer', async () => {
    user = viewer
    mockStatus({ missing: 12 })

    render(<EmbeddingBackfillNotice />)

    await waitFor(() => expect(clientFetch).not.toHaveBeenCalled())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
