import { useEffect, useState, useCallback, useRef } from 'react'
import { clientFetch } from '@/lib/client-api'

export type PipelineStatus = 'queued' | 'processing' | 'complete' | 'error'

export interface PipelineStep {
  step_name: string
  status: string
  error: string | null
  started_at: string | null
  completed_at: string | null
}

export interface PipelineStatusData {
  id: string
  pipeline_status: PipelineStatus | null
  error?: string | null
  steps: PipelineStep[]
}

interface UsePipelineStatusOptions {
  resourceId: string
  /** Set to false to disable polling (default: true) */
  enabled?: boolean
  /** Initial status to avoid a loading flash */
  initialStatus?: PipelineStatus | null
  /** Polling interval in ms (default: 500) */
  interval?: number
  /** Called once when pipeline transitions to a terminal state (complete or error).
   *  Does NOT fire on initial load if already terminal — only on actual transitions. */
  onSettled?: (status: PipelineStatus) => void
}

/**
 * Polls pipeline status for a resource using sequential setTimeout chains.
 * Each poll waits for the previous response before scheduling the next,
 * preventing parallel requests and ensuring reliable stop on terminal state.
 * Call refetch() to restart polling (e.g. after reprocess).
 */
export function usePipelineStatus({
  resourceId,
  enabled = true,
  initialStatus = null,
  interval = 500,
  onSettled,
}: UsePipelineStatusOptions) {
  const [data, setData] = useState<PipelineStatusData | null>(
    initialStatus ? { id: resourceId, pipeline_status: initialStatus, steps: [] } : null
  )
  const [loading, setLoading] = useState(true)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(false)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  // Tracks whether we've seen a non-terminal state (or triggered via refetch),
  // so onSettled only fires on actual transitions, not on initial load.
  const hasSeenActiveRef = useRef(false)

  const stopPolling = useCallback(() => {
    activeRef.current = false
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  // Poll function ref — updated every render to capture latest resourceId/interval.
  // Uses setTimeout chain: fetch → process → schedule next (no parallel requests).
  const pollRef = useRef<(() => Promise<void>) | undefined>(undefined)
  pollRef.current = async () => {
    if (!activeRef.current) return

    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/pipeline-status`)
      if (!activeRef.current) return

      if (!res.ok) {
        timeoutRef.current = setTimeout(() => pollRef.current?.(), interval)
        return
      }

      const json: PipelineStatusData = await res.json()
      setData(json)
      setLoading(false)

      const isTerminal = json.pipeline_status === 'complete' || json.pipeline_status === 'error'
      if (isTerminal) {
        activeRef.current = false
        if (hasSeenActiveRef.current && json.pipeline_status) {
          hasSeenActiveRef.current = false
          onSettledRef.current?.(json.pipeline_status)
        }
        return
      }

      hasSeenActiveRef.current = true
      timeoutRef.current = setTimeout(() => pollRef.current?.(), interval)
    } catch {
      setLoading(false)
      if (activeRef.current) {
        timeoutRef.current = setTimeout(() => pollRef.current?.(), interval)
      }
    }
  }

  const startPolling = useCallback(() => {
    stopPolling()
    activeRef.current = true
    pollRef.current?.()
  }, [stopPolling])

  // Refetch and restart polling (e.g. after reprocess)
  const refetch = useCallback(() => {
    hasSeenActiveRef.current = true
    startPolling()
  }, [startPolling])

  useEffect(() => {
    if (!enabled) return
    startPolling()
    return stopPolling
  }, [enabled, startPolling, stopPolling])

  return {
    data,
    loading,
    status: data?.pipeline_status ?? null,
    steps: data?.steps ?? [],
    error: data?.error ?? null,
    refetch,
  }
}
