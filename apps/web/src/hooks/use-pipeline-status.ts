import { useEffect, useState, useCallback, useRef } from 'react'
import type { PipelineStatus } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'

// Re-exported rather than redeclared: a copy of the union here is a copy the
// compiler cannot check against the API, and a status added on the server would
// reach these components with nothing to render it.
export type { PipelineStatus }

export interface PipelineStep {
  id: string
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
  updated?: string | null
  /** Where a revert would put the content, and the generation it would act on.
   *  Echoed back verbatim: the destination makes a resend land in the same
   *  place, the generation refuses one overtaken by newer content (ADR-044 §4). */
  revert_target?: number | null
  live_revision?: string | null
  steps: PipelineStep[]
}

/**
 * What to tell someone about a failed run.
 *
 * The pipeline's own message, or the first step that carries one: a failure is
 * recorded on the step that hit it and only sometimes copied up, so reading
 * just the top would say nothing for the ordinary case. A property of the
 * payload rather than of any one view, and both the badge and the detail panel
 * answer it from the same two places.
 */
export function failureReason(data: Pick<PipelineStatusData, 'error' | 'steps'>): string | null {
  return data.error ?? data.steps.find((s) => s.error)?.error ?? null
}

interface UsePipelineStatusOptions {
  resourceId: string
  /** Set to false to disable polling (default: true) */
  enabled?: boolean
  /** Initial status to avoid a loading flash */
  initialStatus?: PipelineStatus | null
  /** Initial polling interval in ms (default: 500). Backs off exponentially up to maxInterval. */
  interval?: number
  /** Upper bound for the backed-off polling interval in ms (default: 5000).
   *  Keeps a long-queued resource from polling at high frequency indefinitely. */
  maxInterval?: number
  /** Called once when pipeline transitions to a terminal state (complete or error).
   *  Does NOT fire on initial load if already terminal — only on actual transitions. */
  onSettled?: (status: PipelineStatus) => void
  /** When true, treat the first poll as an active transition (fire onSettled even if
   *  the first result is already terminal). Use after triggering a reprocess. */
  initialActive?: boolean
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
  maxInterval = 5000,
  onSettled,
  initialActive = false,
}: UsePipelineStatusOptions) {
  const [data, setData] = useState<PipelineStatusData | null>(
    initialStatus ? { id: resourceId, pipeline_status: initialStatus, steps: [] } : null
  )
  const [loading, setLoading] = useState(true)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(false)
  // Current backoff delay; grows each reschedule up to maxInterval, reset on (re)start.
  const delayRef = useRef(interval)
  // Last observed status — a change (e.g. queued → processing) resets the backoff
  // so completion is detected promptly after a long queue wait.
  const lastStatusRef = useRef<PipelineStatus | null>(initialStatus)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  // Tracks whether we've seen a non-terminal state (or triggered via refetch),
  // so onSettled only fires on actual transitions, not on initial load.
  const hasSeenActiveRef = useRef(initialActive)

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

    // Schedule the next poll using the current backoff delay, then grow it
    // (exponential, capped at maxInterval) so a long-queued resource stops
    // polling at high frequency.
    const scheduleNext = () => {
      timeoutRef.current = setTimeout(() => pollRef.current?.(), delayRef.current)
      delayRef.current = Math.min(delayRef.current * 2, maxInterval)
    }

    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/pipeline-status`)
      if (!activeRef.current) return

      if (!res.ok) {
        scheduleNext()
        return
      }

      const json: PipelineStatusData = await res.json()
      setData(json)
      setLoading(false)

      // `cancelled` settles too — the run was stopped on purpose (ADR-044 §4)
      // and nothing is coming, so polling on would never end. So does
      // `pending`: nothing writes that status, it is the row's default, so a
      // row wearing it has nothing queued and nothing running either.
      const isTerminal =
        json.pipeline_status === 'complete' ||
        json.pipeline_status === 'error' ||
        json.pipeline_status === 'cancelled' ||
        json.pipeline_status === 'pending'
      if (isTerminal) {
        activeRef.current = false
        if (hasSeenActiveRef.current && json.pipeline_status) {
          hasSeenActiveRef.current = false
          onSettledRef.current?.(json.pipeline_status)
        }
        return
      }

      // A status change (queued → processing) means fresh activity — reset the
      // backoff so the next transition is caught quickly.
      if (json.pipeline_status !== lastStatusRef.current) {
        delayRef.current = interval
      }
      lastStatusRef.current = json.pipeline_status
      hasSeenActiveRef.current = true
      scheduleNext()
    } catch {
      setLoading(false)
      if (activeRef.current) {
        scheduleNext()
      }
    }
  }

  const startPolling = useCallback(() => {
    stopPolling()
    delayRef.current = interval
    lastStatusRef.current = null
    activeRef.current = true
    pollRef.current?.()
  }, [stopPolling, interval])

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
    revertTarget: data?.revert_target ?? null,
    liveRevision: data?.live_revision ?? null,
    refetch,
  }
}
