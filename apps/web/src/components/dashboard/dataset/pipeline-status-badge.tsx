'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import {
  failureReason,
  usePipelineStatus,
  type PipelineStatus,
  type PipelineStatusData,
} from '@/hooks/use-pipeline-status'

interface PipelineStatusBadgeProps {
  resourceId: string
  initialStatus?: PipelineStatus | null
  /** Fires when polling observes the pipeline settling (complete or error) */
  onSettled?: (status: PipelineStatus) => void
}

const STATUS_CONFIG: Record<
  PipelineStatus,
  { variant: 'outline' | 'default' | 'secondary' | 'destructive'; className?: string }
> = {
  pending: { variant: 'outline' },
  queued: { variant: 'outline' },
  processing: { variant: 'default', className: 'animate-pulse' },
  complete: {
    variant: 'secondary',
    className: 'bg-success/15 text-success-tint-foreground',
  },
  error: { variant: 'destructive' },
  // Not a failure, but not finished either: the resource holds content that no
  // version, preview or index describes (ADR-044 §4), so it reads as a warning
  // rather than as a neutral resting state.
  cancelled: {
    variant: 'secondary',
    className: 'bg-warning/15 text-warning-tint-foreground',
  },
}

export const STATUS_KEYS: Record<PipelineStatus, string> = {
  pending: 'pipelinePending',
  queued: 'pipelineQueued',
  processing: 'pipelineProcessing',
  complete: 'pipelineComplete',
  error: 'pipelineError',
  cancelled: 'pipelineCancelled',
}

/**
 * Why a settled pipeline failed, for a row that arrived already failed.
 *
 * The list only ever carried the status, so a failed resource showed a red
 * badge and nothing else — the reason was in the API all along, and reaching it
 * meant leaving the dashboard for the public resource page (kukan#285,
 * kukan#296). Half of what it says is not about the file at all: a site behind
 * an IP allowlist answers the worker with 403, and "403" is the whole
 * explanation.
 *
 * Only for rows nothing polled. A row that fails while the page is open has the
 * answer already — the poll that observed the failure read the same body — so
 * asking again would be a second request for data in hand.
 *
 * Read from the status endpoint because that is where the decision about who
 * may see an error text already lives. Carrying it on the list response would
 * be cheaper still, and is the better home for it; that wants the sanitisation
 * extracted so both routes share one copy, which is more than this change.
 */
function useFailureReason(resourceId: string, ask: boolean): string | null {
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    // Cleared rather than left: the line renders on `reason` alone, so a row
    // re-rendered into a different status would keep the old one under it.
    if (!ask) {
      setReason(null)
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/pipeline-status`, {
          signal: controller.signal,
        })
        if (!res.ok) return
        setReason(failureReason((await res.json()) as PipelineStatusData))
      } catch {
        // The badge is still right without it; a reason nobody could fetch is
        // not worth an error of its own.
      }
    })()
    return () => controller.abort()
  }, [resourceId, ask])

  return reason
}

export function PipelineStatusBadge({
  resourceId,
  initialStatus,
  onSettled,
}: PipelineStatusBadgeProps) {
  const t = useTranslations('resource')
  const shouldPoll = initialStatus === 'queued' || initialStatus === 'processing'
  const { status, data } = usePipelineStatus({
    resourceId,
    enabled: shouldPoll,
    initialStatus,
    // Polling only runs off a non-terminal snapshot, so even a first poll
    // that is already terminal is a settling the owner must hear about
    initialActive: true,
    onSettled,
  })

  // When a parent refetch flips initialStatus to a terminal state, polling is
  // disabled before the hook's last-polled data catches up — the prop is the
  // fresher source then, so prefer it (a bulk upload otherwise leaves badges
  // stuck on queued/processing until a reload)
  const displayStatus = shouldPoll ? status : (initialStatus ?? null)
  const failed = displayStatus === 'error'
  const fetched = useFailureReason(resourceId, failed && !shouldPoll)
  // `data` is seeded from `initialStatus` before anything is polled, so it only
  // answers this once polling has actually run; otherwise the row arrived
  // failed and the reason had to be asked for.
  const polled = shouldPoll && data ? failureReason(data) : null
  const reason = failed ? (polled ?? fetched) : null

  if (!displayStatus) return null

  const config = STATUS_CONFIG[displayStatus]
  const label = t(STATUS_KEYS[displayStatus])

  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={config.variant} className={config.className}>
        {label}
      </Badge>
      {reason && (
        // Truncated with the whole text on hover, as the pipeline detail panel
        // shows a step's error: enough to recognise the cause in a list, and
        // all of it for anyone who needs to read it.
        <span className="max-w-[200px] truncate text-xs text-destructive" title={reason}>
          {reason}
        </span>
      )}
    </div>
  )
}
