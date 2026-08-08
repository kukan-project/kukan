'use client'

import { useEffect, useRef, useState } from 'react'
import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import {
  failureReason,
  storedNoVersion,
  usePipelineStatus,
  type PipelineStatus,
  type PipelineStatusData,
} from '@/hooks/use-pipeline-status'

interface PipelineStatusBadgeProps {
  resourceId: string
  initialStatus?: PipelineStatus | null
  /** Fires when polling observes the pipeline settling (complete or error) */
  onSettled?: (status: PipelineStatus) => void
  /**
   * This row's run is one the user just started. A run that finds nothing to do
   * settles before the refetch that follows it, so the badge is handed a
   * finished run and has nothing to watch — asked about, it can still say what
   * became of it.
   */
  justRan?: boolean
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
 * What a settled run says about itself, for a row nothing polled.
 *
 * Two things are read off it, and both were invisible without it. The failure
 * reason: the list only ever carried the status, so a failed resource showed a
 * red badge and nothing else, and reaching the reason meant leaving the
 * dashboard for the public resource page (kukan#285, kukan#296) — half of what
 * it says is not about the file at all, since a site behind an IP allowlist
 * answers the worker with 403 and "403" is the whole explanation. And that the
 * run stored nothing: a run with no work to do settles in tens of milliseconds,
 * so the refetch that follows an upload finds it already complete and the badge
 * never watches it at all.
 *
 * A row that settles while the page is open has both already — the poll that
 * saw it read the same body — so this asks only when nothing polled.
 *
 * Read from the status endpoint because that is where the decision about who
 * may see an error text already lives. Carrying it on the list response would
 * be cheaper still, and is the better home for it; that wants the sanitisation
 * extracted so both routes share one copy, which is more than this change.
 */
function useSettledRun(resourceId: string, ask: boolean): PipelineStatusData | null {
  const [data, setData] = useState<PipelineStatusData | null>(null)

  useEffect(() => {
    // Cleared rather than left: the lines below render on this alone, so a row
    // re-rendered into a different status would keep the old one under it.
    if (!ask) {
      setData(null)
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/pipeline-status`, {
          signal: controller.signal,
        })
        if (!res.ok) return
        setData((await res.json()) as PipelineStatusData)
      } catch {
        // The badge is still right without it; a note nobody could fetch is
        // not worth an error of its own.
      }
    })()
    return () => controller.abort()
  }, [resourceId, ask])

  return data
}

export function PipelineStatusBadge({
  resourceId,
  initialStatus,
  onSettled,
  justRan,
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

  /**
   * A run that finished without storing a version, said where the user is
   * watching — otherwise re-uploading unchanged content looks like nothing
   * happened at all.
   *
   * Held in state rather than read from `data`: the parent's refetch settles
   * the row, which stops the polling that observed this, and the answer has to
   * outlive the observation. The next run clears it on its transition, because
   * until that run's first response lands the poller still holds the previous
   * one's data — which says complete.
   */
  const [sameContent, setSameContent] = useState(false)
  const wasPolling = useRef(shouldPoll)
  useEffect(() => {
    const started = shouldPoll && !wasPolling.current
    wasPolling.current = shouldPoll
    if (started) {
      setSameContent(false)
      return
    }
    if (shouldPoll && data) setSameContent(storedNoVersion(data))
  }, [shouldPoll, data])

  // When a parent refetch flips initialStatus to a terminal state, polling is
  // disabled before the hook's last-polled data catches up — the prop is the
  // fresher source then, so prefer it (a bulk upload otherwise leaves badges
  // stuck on queued/processing until a reload)
  const displayStatus = shouldPoll ? status : (initialStatus ?? null)
  const failed = displayStatus === 'error'
  const settled = useSettledRun(
    resourceId,
    !shouldPoll && (failed || (justRan === true && displayStatus === 'complete'))
  )
  // `data` is seeded from `initialStatus` before anything is polled, so it only
  // answers this once polling has actually run; otherwise the row arrived
  // settled and what became of the run had to be asked for.
  const polled = shouldPoll && data ? failureReason(data) : null
  const reason = failed ? (polled ?? (settled && failureReason(settled))) : null

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
      {(sameContent || (settled !== null && storedNoVersion(settled))) && (
        <span className="max-w-[200px] text-xs text-muted-foreground">
          {t('pipelineNoNewVersion')}
        </span>
      )}
    </div>
  )
}
