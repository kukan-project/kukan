'use client'

import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { usePipelineStatus, type PipelineStatus } from '@/hooks/use-pipeline-status'

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
  queued: { variant: 'outline' },
  processing: { variant: 'default', className: 'animate-pulse' },
  complete: {
    variant: 'secondary',
    className: 'bg-success/15 text-success-tint-foreground',
  },
  error: { variant: 'destructive' },
}

export const STATUS_KEYS: Record<PipelineStatus, string> = {
  queued: 'pipelineQueued',
  processing: 'pipelineProcessing',
  complete: 'pipelineComplete',
  error: 'pipelineError',
}

export function PipelineStatusBadge({
  resourceId,
  initialStatus,
  onSettled,
}: PipelineStatusBadgeProps) {
  const t = useTranslations('resource')
  const shouldPoll = initialStatus === 'queued' || initialStatus === 'processing'
  const { status } = usePipelineStatus({
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

  if (!displayStatus) return null

  const config = STATUS_CONFIG[displayStatus]
  const label = t(STATUS_KEYS[displayStatus])

  return (
    <Badge variant={config.variant} className={config.className}>
      {label}
    </Badge>
  )
}
