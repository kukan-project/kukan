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
            step_name: 'extract',
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
      expect(result.current.steps[1].step_name).toBe('extract')
    })

    it('should not poll when enabled is false', async () => {
      const { result } = renderHook(() => usePipelineStatus({ resourceId: 'r1', enabled: false }))

      // Give it time to potentially make a call
      await new Promise((r) => setTimeout(r, 50))

      expect(mockClientFetch).not.toHaveBeenCalled()
      expect(result.current.status).toBeNull()
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
})
