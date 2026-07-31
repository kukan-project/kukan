import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { usePipelineStatus } from '../use-pipeline-status'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response
}

describe('usePipelineStatus', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  describe('basic behavior', () => {
    it('should fetch status on mount', async () => {
      const statusData = {
        id: 'r1',
        pipeline_status: 'complete',
        steps: [],
      }
      mockClientFetch.mockResolvedValue(jsonResponse(statusData))

      const { result } = renderHook(() => usePipelineStatus({ resourceId: 'r1' }))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status).toBe('complete')
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/pipeline-status')
    })

    it('should use initialStatus before first fetch', () => {
      mockClientFetch.mockReturnValue(new Promise(() => {})) // never resolves

      const { result } = renderHook(() =>
        usePipelineStatus({ resourceId: 'r1', initialStatus: 'queued' })
      )

      expect(result.current.status).toBe('queued')
    })

    it('should return steps data', async () => {
      const statusData = {
        id: 'r1',
        pipeline_status: 'complete',
        steps: [
          {
            step_name: 'fetch',
            status: 'complete',
            error: null,
            started_at: '2025-01-01T00:00:00Z',
            completed_at: '2025-01-01T00:00:01Z',
          },
          {
            step_name: 'interpret',
            status: 'complete',
            error: null,
            started_at: '2025-01-01T00:00:01Z',
            completed_at: '2025-01-01T00:00:02Z',
          },
        ],
      }
      mockClientFetch.mockResolvedValue(jsonResponse(statusData))

      const { result } = renderHook(() => usePipelineStatus({ resourceId: 'r1' }))

      await waitFor(() => {
        expect(result.current.steps).toHaveLength(2)
      })

      expect(result.current.steps[0].step_name).toBe('fetch')
      expect(result.current.steps[1].step_name).toBe('interpret')
    })

    it('should not poll when enabled is false', async () => {
      const { result } = renderHook(() => usePipelineStatus({ resourceId: 'r1', enabled: false }))

      // Give it time to potentially make a call
      await new Promise((r) => setTimeout(r, 50))

      expect(mockClientFetch).not.toHaveBeenCalled()
      expect(result.current.status).toBeNull()
    })
  })

  describe('onSettled', () => {
    it('does not fire onSettled on mount when already terminal (default initialActive=false)', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ id: 'r1', pipeline_status: 'complete', steps: [] })
      )
      const onSettled = vi.fn()
      const { result } = renderHook(() => usePipelineStatus({ resourceId: 'r1', onSettled }))

      await waitFor(() => expect(result.current.loading).toBe(false))
      // Regression: viewing a finished pipeline's status must NOT fire onSettled
      // (which would refresh the page and close the status dialog).
      expect(onSettled).not.toHaveBeenCalled()
    })

    it('fires onSettled on mount when initialActive is set (post-reprocess scenario)', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ id: 'r1', pipeline_status: 'complete', steps: [] })
      )
      const onSettled = vi.fn()
      renderHook(() => usePipelineStatus({ resourceId: 'r1', initialActive: true, onSettled }))

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith('complete'))
    })
  })

  describe('polling with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should stop polling on complete', async () => {
      const statusData = {
        id: 'r1',
        pipeline_status: 'complete',
        steps: [],
      }
      mockClientFetch.mockResolvedValue(jsonResponse(statusData))

      renderHook(() => usePipelineStatus({ resourceId: 'r1', interval: 1000 }))

      // Let initial poll complete
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const callCount = mockClientFetch.mock.calls.length

      // Advance past several intervals — no new polls should fire
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(mockClientFetch.mock.calls.length).toBe(callCount)
    })

    it('should stop polling on error', async () => {
      const statusData = {
        id: 'r1',
        pipeline_status: 'error',
        error: 'Something failed',
        steps: [],
      }
      mockClientFetch.mockResolvedValue(jsonResponse(statusData))

      renderHook(() => usePipelineStatus({ resourceId: 'r1', interval: 1000 }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const callCount = mockClientFetch.mock.calls.length

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(mockClientFetch.mock.calls.length).toBe(callCount)
    })

    it('should clean up on unmount', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ id: 'r1', pipeline_status: 'processing', steps: [] })
      )

      const { unmount } = renderHook(() => usePipelineStatus({ resourceId: 'r1', interval: 1000 }))

      // Let initial poll complete and schedule next
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const callCount = mockClientFetch.mock.calls.length

      unmount()

      // Advance — no new polls should fire
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(mockClientFetch.mock.calls.length).toBe(callCount)
    })
  })

  describe('backoff while non-terminal', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('backs off exponentially up to maxInterval for a long-queued resource', async () => {
      mockClientFetch.mockResolvedValue(
        jsonResponse({ id: 'r1', pipeline_status: 'queued', steps: [] })
      )

      renderHook(() => usePipelineStatus({ resourceId: 'r1', interval: 500, maxInterval: 4000 }))

      // Initial poll (immediate).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(1)

      // Delays grow 500 → 1000 → 2000 → 4000 (capped). Just under each boundary
      // no new poll fires; crossing it triggers exactly one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(2) // after 500ms

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(3) // after +1000ms

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(4) // after +2000ms

      // Capped at 4000ms thereafter.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(5)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(6)
    })

    it('resets the backoff when the status changes (queued → processing)', async () => {
      // Two queued polls (delay grows to 1000), then processing resets it to 500.
      mockClientFetch
        .mockResolvedValueOnce(jsonResponse({ id: 'r1', pipeline_status: 'queued', steps: [] }))
        .mockResolvedValueOnce(jsonResponse({ id: 'r1', pipeline_status: 'queued', steps: [] }))
        .mockResolvedValue(jsonResponse({ id: 'r1', pipeline_status: 'processing', steps: [] }))

      renderHook(() => usePipelineStatus({ resourceId: 'r1', interval: 500, maxInterval: 8000 }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      // poll 2 after 500ms (still queued → delay now 1000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      // poll 3 after 1000ms returns 'processing' → resets delay to 500
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(3)

      // Next poll fires 500ms later (reset), not 2000ms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(mockClientFetch).toHaveBeenCalledTimes(4)
    })
  })
})
